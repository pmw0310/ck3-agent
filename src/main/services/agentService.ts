import crypto from 'node:crypto'
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part
} from '@google/genai'
import { env, pipeline } from '@huggingface/transformers'
import * as R from 'remeda'
import {
  ADVISOR_SYSTEM_PROMPT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODELS,
  GENERAL_ADVISOR_SYSTEM_PROMPT
} from '@shared/constants'
import type {
  AgentStreamChunkEvent,
  AgentToolStepEvent,
  ChatMode,
  ChatRequestPayload,
  ChatResponsePayload,
  GeminiModelOption,
  ToolExecutionStep
} from '@shared/types'
import {
  getModelsCacheDir,
  loadAppConfig,
  loadGeminiApiKey,
  sanitizeSensitiveText
} from '@/main/services/configService'
import {
  buildCrossSessionMemoryDigest,
  searchPastChatSessions
} from '@/main/services/chatSessionService'
import {
  getCurrentSaveSummary,
  getIndexCounts,
  getScriptEntriesByKey,
  lookupLocalizationMap,
  querySaveCharacters,
  querySaveRealmAndTitles,
  querySaveWarsFactionsAndRegiments,
  searchScriptsHybrid,
  type CharacterQueryFilter,
  type TitleQueryFilter
} from '@/main/services/dbService'

const MAX_SAVE_ANALYSIS_ITERATIONS = 14
const MAX_GENERAL_ADVISOR_ITERATIONS = 6
const MAX_QUERY_EMBEDDING_CACHE = 128
const STREAM_CHUNK_THROTTLE_MS = 32

const buildForcedSynthesisSystemPrompt = (baseSystemPrompt: string): string => `${baseSystemPrompt}

[최종 보고서 합성 강제 지침]
현재 모든 도구 조회 단계가 완료되었습니다. 추가 도구 호출을 절대 시도하지 마십시오.
지금까지 조회된 데이터 응답과 지식을 모두 근거로 삼아, 사용자의 질문에 대한 구체적이고 완성도 높은 최종 마크다운 답변을 즉시 작성하십시오.`

type FeatureExtractorFn = (
  texts: string | string[],
  options?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }
) => Promise<{ data: Float32Array }>

let cachedExtractor: FeatureExtractorFn | null = null
let cachedExtractorModel = ''
let extractorInitPromise: Promise<FeatureExtractorFn | null> | null = null
const queryEmbeddingCache = new Map<string, Float32Array>()

const getQueryExtractor = async (modelName: string): Promise<FeatureExtractorFn | null> => {
  if (cachedExtractor && cachedExtractorModel === modelName) {
    return cachedExtractor
  }
  if (extractorInitPromise && cachedExtractorModel === modelName) {
    return await extractorInitPromise
  }

  cachedExtractorModel = modelName
  extractorInitPromise = (async () => {
    try {
      env.cacheDir = getModelsCacheDir()
      env.allowLocalModels = true
      env.allowRemoteModels = true

      const extractor = (await pipeline('feature-extraction', modelName, {
        dtype: 'q8'
      })) as unknown as FeatureExtractorFn

      cachedExtractor = extractor
      return extractor
    } catch {
      cachedExtractorModel = ''
      return null
    } finally {
      extractorInitPromise = null
    }
  })()

  return await extractorInitPromise
}

const embedSearchQuery = async (
  queryText: string,
  embeddingModel: string
): Promise<Float32Array | null> => {
  const { scriptCount } = getIndexCounts()
  if (scriptCount === 0) return null

  const normalizedModel = embeddingModel || DEFAULT_EMBEDDING_MODEL
  const cacheKey = `${normalizedModel}::${queryText.trim().toLowerCase()}`
  const hit = queryEmbeddingCache.get(cacheKey)
  if (hit) {
    queryEmbeddingCache.delete(cacheKey)
    queryEmbeddingCache.set(cacheKey, hit)
    return hit
  }

  const extractor = await getQueryExtractor(normalizedModel)
  if (!extractor) return null

  try {
    const output = await extractor(queryText, { pooling: 'mean', normalize: true })
    const vec =
      output.data instanceof Float32Array ? output.data : new Float32Array(output.data)
    if (queryEmbeddingCache.size >= MAX_QUERY_EMBEDDING_CACHE) {
      const oldestKey = queryEmbeddingCache.keys().next().value
      if (oldestKey) queryEmbeddingCache.delete(oldestKey)
    }
    queryEmbeddingCache.set(cacheKey, vec)
    return vec
  } catch {
    return null
  }
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  getSaveOverview: '로드된 세이브 군주 및 국가 개요 조회',
  queryCharacters: '세이브 인물·봉신·후계자 상세 조회',
  queryRealmAndTitles: '직할령 백작령·건물·문화·종교 조회',
  queryWarsFactionsAndSchemes: '전쟁·파벌·무장병·모략 현황 조회',
  searchGameScriptsSemantic: '본편·모드 스크립트 하이브리드 검색',
  getGameScriptByKey: '특정 게임·모드 스크립트 원문 정밀 조회',
  lookupLocalization: '한국어·영문 로컬라이제이션 명칭 변환',
  recallPastConversations: '이전·다른 채팅방 대화 맥락 참조'
}

const SAVE_STATE_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'getSaveOverview',
    description:
      '현재 로드된 CK3 세이브 파일의 플레이어 군주 요약, 능력치, 보유 자원(금화/수입/위신/신앙심/명성/공포/스트레스), 트레잇, 대표 작위, 총 병력, 세이브 내 활성 모드 목록을 조회합니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  },
  {
    name: 'queryCharacters',
    description:
      '세이브 파일 내 인물(플레이어, 봉신, 궁정 신하, 자녀/후계자, 특정 이름/ID 인물)의 능력치, 트레잇, 병력, 금화, 클레임, 가족 관계를 조회합니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        relation: {
          type: Type.STRING,
          description: '조회 대상 관계 구분',
          enum: ['player', 'vassals', 'courtiers', 'heirs', 'all']
        },
        searchName: {
          type: Type.STRING,
          description: '인물 이름 또는 작위 키 검색어 (선택)'
        },
        characterIds: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: '특정 인물 ID 배열 조회 시 지정 (선택)'
        },
        sortBy: {
          type: Type.STRING,
          description: '정렬 기준 컬럼',
          enum: [
            'military_strength',
            'stewardship',
            'martial',
            'diplomacy',
            'intrigue',
            'learning',
            'prowess',
            'gold'
          ]
        },
        limit: {
          type: Type.NUMBER,
          description: '최대 반환 인원 수 (기본 15, 최대 50)'
        }
      }
    }
  },
  {
    name: 'queryRealmAndTitles',
    description:
      '플레이어 직할령(개발도, 건설된 건물 목록, 상속법, 후계자 순서), 봉신 작위, 플레이어의 신앙 교리 및 문화 전통/혁신 현황을 조회합니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        scope: {
          type: Type.STRING,
          description: '조회 범위 구분',
          enum: ['player_domain', 'player_vassals', 'specific_keys', 'top_development']
        },
        titleKeys: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '특정 작위 키 배열 (예: ["c_roma", "k_italy"])'
        },
        limit: {
          type: Type.NUMBER,
          description: '최대 반환 작위 수 (기본 25)'
        }
      }
    }
  },
  {
    name: 'queryWarsFactionsAndSchemes',
    description:
      '현재 진행 중인 전쟁(전쟁 점수, 개전 사유, 공격/방어측), 결성된 파벌(불만도, 세력 비율, 참가 봉신), 보유 무장병(MAA 연대 종류·규모·주둔지), 활성 모략을 조회합니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {}
    }
  }
]

const SCRIPT_VFS_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'searchGameScriptsSemantic',
    description:
      '인덱싱된 CK3 본편 및 활성 모드 스크립트(Clausewitz VFS 병합 완료 기준)에서 결단(decisions), 트레잇(traits), 특전(perks), 가문 유산(dynasty_perks), 기본 변동치(modifiers), 시스템 상수(defines), 건물(buildings), 무장병(men_at_arms_types), 문화 전통/혁신(culture_traditions, culture_innovations), 종교 교리/교의(religion_doctrines, religion_tenets), 법률(laws), 봉신 계약(vassal_contracts) 등을 다국어 임베딩 벡터 + 키워드로 검색합니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: '검색 질의어 (한국어 명칭, 게임 개념, 영문 스크립트 키워드 모두 가능)'
        },
        category: {
          type: Type.STRING,
          description:
            '특정 카테고리 필터 (선택: decisions, traits, buildings, men_at_arms_types, culture_traditions, culture_innovations, culture_pillars, religion_doctrines, religion_tenets, laws, vassal_contracts, casus_belli_types, governments, lifestyles, perks, dynasty_perks, modifiers, defines, schemes, character_interactions)'
        },
        limit: {
          type: Type.NUMBER,
          description: '반환 개수 (기본 8, 최대 20)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'getGameScriptByKey',
    description:
      '특정 스크립트 키(entryKey) 또는 한글 명칭으로 본편/모드 스크립트의 정확한 원문(is_shown, is_valid, cost, effect, modifier 등)과 파싱된 JSON, 출처 모드를 정밀 조회합니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        entryKey: {
          type: Type.STRING,
          description: '조회할 스크립트 키 또는 정확한 명칭 (예: restore_roman_empire_decision)'
        },
        category: {
          type: Type.STRING,
          description: '카테고리 필터 (선택)'
        }
      },
      required: ['entryKey']
    }
  },
  {
    name: 'lookupLocalization',
    description: 'CK3 내부 키(작위, 트레잇, 문화, 신앙, 건물 키 등)를 한국어/영어 로컬라이제이션 텍스트로 변환합니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        keys: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '번역 조회할 로컬라이제이션 키 배열'
        }
      },
      required: ['keys']
    }
  },
  {
    name: 'recallPastConversations',
    description:
      '사용자가 다른 채팅방이나 이전 대화에서 나눴던 질문·전략 논의·결론을 키워드로 검색하거나 최근 대화 원문을 상세 조회하여 대화 간 맥락을 자연스럽게 이어갑니다.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: '찾고자 하는 이전 대화 주제나 키워드 (생략 시 가장 최근 다른 대화들을 조회)'
        },
        limit: {
          type: Type.NUMBER,
          description: '조회할 최대 대화방 수 (기본 5)'
        }
      }
    }
  }
]

const ADVISOR_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  ...SAVE_STATE_FUNCTION_DECLARATIONS,
  ...SCRIPT_VFS_FUNCTION_DECLARATIONS
]

const SAVE_ONLY_TOOL_NAMES = new Set([
  'getSaveOverview',
  'queryCharacters',
  'queryRealmAndTitles',
  'queryWarsFactionsAndSchemes'
])

const executeSingleTool = async (
  toolName: string,
  args: Record<string, unknown>,
  embeddingModel: string,
  chatMode: ChatMode,
  currentSessionId?: string
): Promise<{ payload: unknown; summary: string }> => {
  if (chatMode === 'general_advisor' && SAVE_ONLY_TOOL_NAMES.has(toolName)) {
    return {
      payload: {
        skipped: true,
        message: '현재 [일반 질문 · 현인 모드]이므로 세이브 데이터 조회는 수행하지 않습니다.'
      },
      summary: '일반 현인 모드 · 세이브 조회 생략'
    }
  }

  switch (toolName) {
    case 'getSaveOverview': {
      const saveSummary = getCurrentSaveSummary()
      if (!saveSummary) {
        return {
          payload: { loaded: false, message: '현재 로드된 세이브 파일이 없습니다.' },
          summary: '로드된 세이브 없음'
        }
      }
      return {
        payload: { loaded: true, saveSummary },
        summary: `${saveSummary.playerName} · ${saveSummary.primaryTitleName} · ${saveSummary.gameDate}년`
      }
    }

    case 'queryCharacters': {
      const filter: CharacterQueryFilter = {
        relation: (args.relation as CharacterQueryFilter['relation']) ?? 'all',
        searchName: typeof args.searchName === 'string' ? args.searchName : undefined,
        characterIds: Array.isArray(args.characterIds)
          ? args.characterIds.map((id) => Number(id))
          : undefined,
        sortBy: args.sortBy as CharacterQueryFilter['sortBy'],
        limit: typeof args.limit === 'number' ? args.limit : 15
      }
      const relationKoMap: Record<NonNullable<CharacterQueryFilter['relation']>, string> = {
        player: '군주 본인',
        vassals: '주요 봉신',
        courtiers: '궁정 신하',
        heirs: '후계자·가족',
        all: '인물'
      }
      const characters = querySaveCharacters(filter)
      const relLabel = relationKoMap[filter.relation ?? 'all']
      return {
        payload: { count: characters.length, characters },
        summary: `${relLabel} ${characters.length}명 조회 완료`
      }
    }

    case 'queryRealmAndTitles': {
      const filter: TitleQueryFilter = {
        scope: (args.scope as TitleQueryFilter['scope']) ?? 'player_domain',
        titleKeys: Array.isArray(args.titleKeys)
          ? args.titleKeys.map((k) => String(k))
          : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 25
      }
      const data = querySaveRealmAndTitles(filter)
      return {
        payload: data,
        summary: `작위 ${data.titles.length}건 · 문화 및 신앙 ${data.faithAndCulture.length}건 조회`
      }
    }

    case 'queryWarsFactionsAndSchemes': {
      const data = querySaveWarsFactionsAndRegiments()
      return {
        payload: data,
        summary: `전쟁 ${data.wars.length}건 · 파벌 ${data.factions.length}건 · 무장병 ${data.regiments.length}개 연대`
      }
    }

    case 'searchGameScriptsSemantic': {
      const query = String(args.query ?? '').trim()
      const category = typeof args.category === 'string' ? args.category : undefined
      const limit = typeof args.limit === 'number' ? args.limit : 8
      const queryEmbedding = await embedSearchQuery(query, embeddingModel)
      const items = searchScriptsHybrid({
        queryEmbedding,
        keywordQuery: query,
        category,
        limit
      })
      return {
        payload: {
          query,
          usedVectorSearch: Boolean(queryEmbedding),
          count: items.length,
          items
        },
        summary: `"${query}" 관련 스크립트 ${items.length}건 검색`
      }
    }

    case 'getGameScriptByKey': {
      const entryKey = String(args.entryKey ?? '').trim()
      const category = typeof args.category === 'string' ? args.category : undefined
      const items = getScriptEntriesByKey(entryKey, category)
      return {
        payload: { entryKey, count: items.length, items },
        summary: `"${entryKey}" 스크립트 원문 ${items.length}건 조회`
      }
    }

    case 'lookupLocalization': {
      const keys = Array.isArray(args.keys) ? args.keys.map((k) => String(k)) : []
      const translations = lookupLocalizationMap(keys)
      return {
        payload: { translations },
        summary: `로컬라이제이션 ${Object.keys(translations).length}/${keys.length}건 매칭`
      }
    }

    case 'recallPastConversations': {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const limit = typeof args.limit === 'number' ? args.limit : 5
      const matches = searchPastChatSessions({
        query,
        excludeSessionId: currentSessionId,
        limit
      })
      return {
        payload: {
          query,
          count: matches.length,
          conversations: matches
        },
        summary:
          matches.length > 0
            ? `이전 대화방 ${matches.length}건 맥락 참조`
            : '참조할 이전 대화 없음'
      }
    }

    default:
      return {
        payload: { error: `알 수 없는 도구입니다: ${toolName}` },
        summary: `알 수 없는 도구 · ${toolName}`
      }
  }
}

/**
 * `@google/genai` SDK의 `ai.models.list()`를 호출하여 사용 가능한 텍스트 추론 Gemini 모델 목록을 동적으로 조회합니다.
 * @param overrideApiKey 설정 저장 전 테스트용 API 키
 * @returns 우선순위 정렬된 모델 옵션 배열
 */
export const listAvailableGeminiModels = async (
  overrideApiKey?: string
): Promise<GeminiModelOption[]> => {
  const apiKey = (overrideApiKey?.trim() || loadGeminiApiKey()).trim()
  if (!apiKey) {
    return FALLBACK_GEMINI_MODELS
  }

  try {
    const ai = new GoogleGenAI({ apiKey })
    const pager = await ai.models.list()
    const fetched: GeminiModelOption[] = []

    for await (const model of pager) {
      const rawName = model.name ?? ''
      const id = rawName.replace(/^models\//, '')
      if (!id.startsWith('gemini-')) continue

      const lower = id.toLowerCase()
      // 서비스 종료된 구형 1.x / 2.x 세대 및 비텍스트 전용 모델 제외
      const isExcluded =
        /^gemini-[12](\.|-|$)/.test(lower) ||
        lower.includes('embedding') ||
        lower.includes('imagen') ||
        lower.includes('veo') ||
        lower.includes('tts') ||
        lower.includes('live') ||
        lower.includes('audio') ||
        lower.includes('aqa')

      if (isExcluded) continue

      const actions = (model as { supportedActions?: string[] }).supportedActions
      if (Array.isArray(actions) && actions.length > 0 && !actions.includes('generateContent')) {
        continue
      }

      fetched.push({
        id,
        displayName: (model.displayName || id).replace(/\s*\([^)]*\)/g, '').trim() || id,
        description: model.description,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit
      })
    }

    const priorityOrder = [
      'gemini-3.8-flash',
      'gemini-4-hydrogen',
      'gemini-4-argon',
      'gemini-4-carbon'
    ]

    const rankModel = (id: string): number => {
      const exactIdx = priorityOrder.indexOf(id)
      if (exactIdx >= 0) return exactIdx
      if (id.startsWith('gemini-4')) return 10
      if (id.startsWith('gemini-3.8')) return 20
      return 50
    }

    return R.pipe(
      [...FALLBACK_GEMINI_MODELS, ...fetched],
      R.uniqueBy((item) => item.id),
      R.sortBy([(item) => rankModel(item.id), 'asc'], [(item) => item.id, 'desc'])
    )
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err)
    throw new Error(sanitizeSensitiveText(rawMsg, apiKey))
  }
}

const activeChatAbortControllers = new Map<string, AbortController>()

/**
 * 진행 중인 Gemini SSE 스트리밍 요청을 중단합니다.
 */
export const cancelAdvisorChatTurn = (requestId: string): void => {
  const controller = activeChatAbortControllers.get(requestId)
  if (controller) {
    controller.abort()
    activeChatAbortControllers.delete(requestId)
  }
}

/**
 * SSE 스트림 청크(`candidates[0].content.parts`)에서 사용자에게 표시할 순수 텍스트 델타만 추출합니다.
 * (`thought: true` 사고 요약 파트 및 `functionCall` 파트는 텍스트 출력에서 제외)
 */
const extractChunkDisplayText = (parts: Part[] | undefined): string => {
  if (!parts || parts.length === 0) return ''
  return R.pipe(
    parts,
    R.filter((part) => !part.thought && typeof part.text === 'string' && part.text.length > 0),
    R.map((part) => part.text as string)
  ).join('')
}

/**
 * `@google/genai`의 SSE 스트리밍(`generateContentStream`, `alt=sse`)과 멀티턴 Tool Calling을 결합하여
 * 실시간으로 텍스트 청크와 도구 실행 상태를 브로드캐스트합니다.
 */
export const runAdvisorChatTurn = async (
  payload: ChatRequestPayload,
  onToolStep: (event: AgentToolStepEvent) => void,
  onStreamChunk?: (event: AgentStreamChunkEvent) => void
): Promise<ChatResponsePayload> => {
  const apiKey = loadGeminiApiKey()
  if (!apiKey) {
    throw new Error('Gemini API 키가 설정되지 않았습니다. 우측 상단 [설정]에서 API 키를 입력해 주세요.')
  }

  const abortController = new AbortController()
  activeChatAbortControllers.set(payload.requestId, abortController)

  const config = loadAppConfig()
  const modelId = config.selectedModel || DEFAULT_GEMINI_MODEL
  const chatMode: ChatMode = payload.mode === 'general_advisor' ? 'general_advisor' : 'save_analysis'
  const isGeneralMode = chatMode === 'general_advisor'

  const activeFunctionDeclarations = isGeneralMode
    ? SCRIPT_VFS_FUNCTION_DECLARATIONS
    : ADVISOR_FUNCTION_DECLARATIONS
  const activeSystemPrompt = isGeneralMode
    ? GENERAL_ADVISOR_SYSTEM_PROMPT
    : ADVISOR_SYSTEM_PROMPT
  const maxToolIterations = isGeneralMode
    ? MAX_GENERAL_ADVISOR_ITERATIONS
    : MAX_SAVE_ANALYSIS_ITERATIONS

  const indexCounts = getIndexCounts()
  const saveSummary = isGeneralMode ? null : getCurrentSaveSummary()
  const crossSessionDigest = buildCrossSessionMemoryDigest(payload.sessionId)

  const runtimeStateNote = isGeneralMode
    ? [
        '[현재 런타임 상태 브리핑]',
        '- 현재 모드: 일반 질문 · 현인 모드 · 개별 세이브 DB 탐색 생략',
        `- 인덱싱된 본편 및 모드 스크립트 수: ${indexCounts.scriptCount.toLocaleString()}건 · 로컬라이제이션: ${indexCounts.locCount.toLocaleString()}건`
      ].join('\n')
    : [
        '[현재 런타임 상태 브리핑]',
        saveSummary
          ? `- 로드된 세이브: ${saveSummary.fileName} · 연도: ${saveSummary.gameDate} · 군주: ${saveSummary.playerName} · ID: ${saveSummary.playerCharacterId} · 대표 작위: ${saveSummary.primaryTitleName} · 키: ${saveSummary.primaryTitleKey}`
          : '- 로드된 세이브: 없음 · 세이브 미로드 상태이므로 필요 시 사용자에게 최신 세이브 불러오기를 안내하고 스크립트 질문은 인덱스로 답변',
        `- 인덱싱된 본편 및 모드 스크립트 수: ${indexCounts.scriptCount.toLocaleString()}건 · 로컬라이제이션: ${indexCounts.locCount.toLocaleString()}건`
      ].join('\n')

  const composedSystemPrompt = [
    activeSystemPrompt,
    runtimeStateNote,
    crossSessionDigest
  ]
    .filter((block) => block.trim().length > 0)
    .join('\n\n')

  const historyContents: Content[] = R.pipe(
    payload.history.slice(-24),
    R.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [
        {
          text:
            turn.role === 'assistant' && turn.toolNotes
              ? `[참고 데이터 요약: ${turn.toolNotes}]\n${turn.content}`
              : turn.content
        }
      ]
    }))
  )

  const contents: Content[] = [
    ...historyContents,
    {
      role: 'user',
      parts: [{ text: payload.message }]
    }
  ]

  const ai = new GoogleGenAI({ apiKey })
  const toolSteps: ToolExecutionStep[] = []
  let accumulatedText = ''
  let pendingDeltaBuffer = ''
  let lastChunkEmitAt = 0

  const flushStreamChunk = (force = false): void => {
    if (!onStreamChunk || !pendingDeltaBuffer) return
    const now = Date.now()
    if (!force && now - lastChunkEmitAt < STREAM_CHUNK_THROTTLE_MS) {
      return
    }
    const delta = pendingDeltaBuffer
    pendingDeltaBuffer = ''
    lastChunkEmitAt = now
    onStreamChunk({
      requestId: payload.requestId,
      deltaText: delta,
      accumulatedText
    })
  }

  const buildAbortedResponse = (): ChatResponsePayload => {
    flushStreamChunk(true)
    onStreamChunk?.({
      requestId: payload.requestId,
      deltaText: '',
      accumulatedText,
      isDone: true,
      aborted: true
    })
    return {
      requestId: payload.requestId,
      reply: accumulatedText.trim() || '응답 생성이 중단되었습니다.',
      modelUsed: modelId,
      toolSteps,
      aborted: true
    }
  }

  /**
   * 도구 호출이 완료되었거나 본문 누락으로 조기 종료되었을 때,
   * `tools` 스키마를 유지한 채 `FunctionCallingConfigMode.NONE`으로 최종 마크다운 보고서 생성을 강제합니다.
   */
  const streamForcedSynthesisTurn = async (): Promise<string> => {
    const finalStream = await ai.models.generateContentStream({
      model: modelId,
      contents,
      config: {
        systemInstruction: buildForcedSynthesisSystemPrompt(composedSystemPrompt),
        tools: [{ functionDeclarations: activeFunctionDeclarations }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.NONE
          }
        },
        temperature: 0.45,
        abortSignal: abortController.signal
      }
    })

    let synthesizedTurnText = ''
    for await (const chunk of finalStream) {
      if (abortController.signal.aborted) break
      const deltaText = extractChunkDisplayText(chunk.candidates?.[0]?.content?.parts)
      if (deltaText) {
        synthesizedTurnText += deltaText
        accumulatedText += deltaText
        pendingDeltaBuffer += deltaText
        flushStreamChunk(false)
      }
    }
    flushStreamChunk(true)
    return synthesizedTurnText
  }

  try {
    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      if (abortController.signal.aborted) {
        return buildAbortedResponse()
      }

      const stream = await ai.models.generateContentStream({
        model: modelId,
        contents,
        config: {
          systemInstruction: composedSystemPrompt,
          tools: [{ functionDeclarations: activeFunctionDeclarations }],
          temperature: 0.45,
          abortSignal: abortController.signal
        }
      })

      const turnModelParts: Part[] = []
      const turnFunctionCalls: FunctionCall[] = []
      let turnDisplayText = ''

      for await (const chunk of stream) {
        if (abortController.signal.aborted) {
          break
        }

        const chunkParts = chunk.candidates?.[0]?.content?.parts
        if (chunkParts && chunkParts.length > 0) {
          turnModelParts.push(...chunkParts)
          for (const part of chunkParts) {
            if (part.functionCall) {
              turnFunctionCalls.push(part.functionCall)
            }
          }
        } else if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          for (const fc of chunk.functionCalls) {
            turnFunctionCalls.push(fc)
            turnModelParts.push({ functionCall: fc })
          }
        }

        const deltaText = extractChunkDisplayText(chunkParts)
        if (deltaText) {
          turnDisplayText += deltaText
          accumulatedText += deltaText
          pendingDeltaBuffer += deltaText
          flushStreamChunk(false)
        }
      }
      flushStreamChunk(true)

      if (abortController.signal.aborted) {
        return buildAbortedResponse()
      }

      if (turnFunctionCalls.length === 0) {
        if (!turnDisplayText.trim()) {
          if (accumulatedText.length > 0 && !accumulatedText.endsWith('\n\n')) {
            accumulatedText = `${accumulatedText.trimEnd()}\n\n`
          }
          await streamForcedSynthesisTurn()
          if (abortController.signal.aborted) {
            return buildAbortedResponse()
          }
        }

        const replyText = accumulatedText.trim() || '응답 텍스트를 생성하지 못했습니다.'
        onStreamChunk?.({
          requestId: payload.requestId,
          deltaText: '',
          accumulatedText: replyText,
          isDone: true
        })
        return {
          requestId: payload.requestId,
          reply: replyText,
          modelUsed: modelId,
          toolSteps
        }
      }

      if (accumulatedText.length > 0 && !accumulatedText.endsWith('\n\n')) {
        accumulatedText = `${accumulatedText.trimEnd()}\n\n`
      }

      const functionResponseParts: Part[] = []

      for (const call of turnFunctionCalls) {
        if (abortController.signal.aborted) break

        const toolName = call.name || 'unknownTool'
        const callArgs = (call.args as Record<string, unknown> | undefined) ?? {}
        const stepId = crypto.randomUUID()
        const displayTitle = TOOL_DISPLAY_NAMES[toolName] ?? toolName
        const startedAt = Date.now()

        const runningStep: ToolExecutionStep = {
          id: stepId,
          toolName,
          displayTitle,
          args: callArgs,
          status: 'running'
        }
        toolSteps.push(runningStep)
        onToolStep({ requestId: payload.requestId, step: { ...runningStep } })

        try {
          const execResult = await executeSingleTool(
            toolName,
            callArgs,
            config.embeddingModel,
            chatMode,
            payload.sessionId
          )
          const durationMs = Date.now() - startedAt
          runningStep.status = 'completed'
          runningStep.resultSummary = execResult.summary
          runningStep.durationMs = durationMs

          onToolStep({ requestId: payload.requestId, step: { ...runningStep } })

          functionResponseParts.push({
            functionResponse: {
              id: call.id,
              name: toolName,
              response: { result: execResult.payload }
            }
          })
        } catch (err) {
          const errMsg = sanitizeSensitiveText(err instanceof Error ? err.message : String(err), apiKey)
          const durationMs = Date.now() - startedAt
          runningStep.status = 'error'
          runningStep.resultSummary = errMsg
          runningStep.durationMs = durationMs

          onToolStep({ requestId: payload.requestId, step: { ...runningStep } })

          functionResponseParts.push({
            functionResponse: {
              id: call.id,
              name: toolName,
              response: { error: errMsg }
            }
          })
        }
      }

      if (abortController.signal.aborted) {
        return buildAbortedResponse()
      }

      contents.push({
        role: 'model',
        parts:
          turnModelParts.length > 0
            ? turnModelParts
            : turnFunctionCalls.map((call) => ({ functionCall: call }))
      })

      contents.push({
        role: 'user',
        parts: functionResponseParts
      })
    }

    if (abortController.signal.aborted) {
      return buildAbortedResponse()
    }

    await streamForcedSynthesisTurn()

    if (abortController.signal.aborted) {
      return buildAbortedResponse()
    }

    const finalReply =
      accumulatedText.trim() || '도구 조회 결과를 바탕으로 분석을 완료했습니다.'
    onStreamChunk?.({
      requestId: payload.requestId,
      deltaText: '',
      accumulatedText: finalReply,
      isDone: true,
      aborted: false
    })

    return {
      requestId: payload.requestId,
      reply: finalReply,
      modelUsed: modelId,
      toolSteps,
      aborted: false
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      return buildAbortedResponse()
    }
    const rawMsg = err instanceof Error ? err.message : String(err)
    throw new Error(sanitizeSensitiveText(rawMsg, apiKey))
  } finally {
    activeChatAbortControllers.delete(payload.requestId)
  }
}
