import type {
  EdgeTtsVoice,
  GeminiModelOption,
  GeminiTtsModel,
  GeminiTtsVoice,
  PresetPromptItem
} from '@shared/types'

/** 크루세이더 킹즈 3 Steam 고유 앱 ID */
export const CK3_STEAM_APP_ID = '1158310'

/** 기본 선택 Gemini 추론 모델 ID */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'

/** 무료 Edge 신경망 TTS 기본 한국어 성우 및 배속 */
export const DEFAULT_EDGE_TTS_VOICE: EdgeTtsVoice = 'ko-KR-InJoonNeural'
export const DEFAULT_EDGE_TTS_RATE = '+0%'
/** 제미나이 전용 TTS 기본 모델 및 성우 */
export const DEFAULT_GEMINI_TTS_MODEL: GeminiTtsModel = 'gemini-3.8-flash-tts'
export const DEFAULT_GEMINI_TTS_VOICE: GeminiTtsVoice = 'Charon'

export const EDGE_TTS_VOICE_OPTIONS: Array<{ id: EdgeTtsVoice; label: string }> = [
  { id: 'ko-KR-InJoonNeural', label: '인준 · 차분한 남성 대재상' },
  { id: 'ko-KR-HyunsuNeural', label: '현수 · 중후한 남성 현인' },
  { id: 'ko-KR-SunHiNeural', label: '선희 · 명료한 여성 자문관' }
]

export const EDGE_TTS_RATE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: '-10%', label: '차분하게 · 0.9배속' },
  { id: '+0%', label: '기본 속도 · 1.0배속' },
  { id: '+10%', label: '약간 빠르게 · 1.1배속' },
  { id: '+20%', label: '빠르게 · 1.2배속' }
]

export const GEMINI_TTS_MODEL_OPTIONS: Array<{ id: GeminiTtsModel; label: string }> = [
  { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS' },
  { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash Lite TTS' }
]

export const GEMINI_TTS_VOICE_OPTIONS: Array<{ id: GeminiTtsVoice; label: string }> = [
  { id: 'Charon', label: 'Charon · 중후한 남성 고문' },
  { id: 'Fenrir', label: 'Fenrir · 강인한 무장 톤' },
  { id: 'Kore', label: 'Kore · 차분한 여성 고문' },
  { id: 'Aoede', label: 'Aoede · 지적인 여성 현인' },
  { id: 'Puck', label: 'Puck · 경쾌한 참모' },
  { id: 'Algenib', label: 'Algenib · 깊고 침착한 성우' }
]

export const FALLBACK_GEMINI_MODELS: GeminiModelOption[] = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    description: '기본 추천 · 빠른 응답 속도와 안정적인 멀티턴 도구 추론 모델'
  },
  {
    id: 'gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen',
    description: '일상적인 세이브·스크립트 교차 분석에 최적화된 고효율 모델'
  },
  {
    id: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    description: '빠른 응답과 심층 논리 추론의 균형을 갖춘 프론티어 모델'
  },
  {
    id: 'gemini-4-carbon',
    displayName: 'Gemini 4 Carbon',
    description: '복잡한 상속법, 다중 모드 시너지, 장기 캠페인 설계용 최상위 모델'
  }
]

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

export const EMBEDDING_DIMENSIONS = 384

export const INDEX_TARGET_CATEGORIES: Array<{
  category: string
  relDir: string
  labelKo: string
}> = [
  { category: 'decisions', relDir: 'common/decisions', labelKo: '결단' },
  { category: 'traits', relDir: 'common/traits', labelKo: '트레잇' },
  { category: 'buildings', relDir: 'common/buildings', labelKo: '건물' },
  { category: 'men_at_arms_types', relDir: 'common/men_at_arms_types', labelKo: '무장병' },
  { category: 'culture_traditions', relDir: 'common/culture/traditions', labelKo: '문화 전통' },
  { category: 'culture_innovations', relDir: 'common/culture/innovations', labelKo: '문화 혁신' },
  { category: 'culture_pillars', relDir: 'common/culture/pillars', labelKo: '문화 기둥' },
  {
    category: 'religion_doctrines',
    relDir: 'common/religion/doctrine_types',
    labelKo: '종교 교리'
  },
  {
    category: 'religion_tenets',
    relDir: 'common/religion/tenet_types',
    labelKo: '핵심 교의'
  },
  { category: 'laws', relDir: 'common/laws', labelKo: '법률' },
  {
    category: 'vassal_contracts',
    relDir: 'common/subject_contracts/contracts',
    labelKo: '봉신 계약'
  },
  { category: 'casus_belli_types', relDir: 'common/casus_belli_types', labelKo: '개전 사유' },
  { category: 'governments', relDir: 'common/governments', labelKo: '정부 형태' },
  { category: 'lifestyles', relDir: 'common/lifestyles', labelKo: '인생관' },
  { category: 'perks', relDir: 'common/lifestyle_perks', labelKo: '특전' },
  { category: 'dynasty_perks', relDir: 'common/dynasty_perks', labelKo: '가문 유산' },
  { category: 'modifiers', relDir: 'common/modifiers', labelKo: '기본 변동치' },
  { category: 'defines', relDir: 'common/defines', labelKo: '시스템 상수' },
  { category: 'schemes', relDir: 'common/schemes/scheme_types', labelKo: '모략' },
  {
    category: 'character_interactions',
    relDir: 'common/character_interactions',
    labelKo: '인물 상호작용'
  },
  { category: 'scripted_triggers', relDir: 'common/scripted_triggers', labelKo: '스크립트 조건' },
  { category: 'scripted_effects', relDir: 'common/scripted_effects', labelKo: '스크립트 효과' }
]

export const IPC_CHANNELS = {
  GET_SETTINGS: 'ck3:get-settings',
  UPDATE_SETTINGS: 'ck3:update-settings',
  AUTO_DETECT_PATHS: 'ck3:auto-detect-paths',
  SELECT_DIRECTORY: 'ck3:select-directory',
  SELECT_SAVE_FILE: 'ck3:select-save-file',
  CHECK_VERSION: 'ck3:check-version',
  START_INDEXING: 'ck3:start-indexing',
  CANCEL_INDEXING: 'ck3:cancel-indexing',
  LOAD_LATEST_SAVE: 'ck3:load-latest-save',
  LOAD_SAVE_BY_PATH: 'ck3:load-save-by-path',
  GET_CURRENT_SAVE_SUMMARY: 'ck3:get-current-save-summary',
  LIST_GEMINI_MODELS: 'ck3:list-gemini-models',
  SEND_CHAT_MESSAGE: 'ck3:send-chat-message',
  CANCEL_CHAT_MESSAGE: 'ck3:cancel-chat-message',
  LIST_CHAT_SESSIONS: 'ck3:list-chat-sessions',
  SAVE_CHAT_SESSION: 'ck3:save-chat-session',
  DELETE_CHAT_SESSION: 'ck3:delete-chat-session',
  SYNTHESIZE_TTS: 'ck3:synthesize-tts',
  EVENT_INDEX_PROGRESS: 'ck3:event:index-progress',
  EVENT_SAVE_PROGRESS: 'ck3:event:save-progress',
  EVENT_VERSION_CHECK: 'ck3:event:version-check',
  EVENT_AGENT_TOOL_STEP: 'ck3:event:agent-tool-step',
  EVENT_AGENT_STREAM_CHUNK: 'ck3:event:agent-stream-chunk'
} as const

/**
 * 구버전 CK3 사전 학습 지식으로 인한 오답 환각을 막기 위한 현행 1.20+ 메카닉 팩트 가드레일
 */
export const CK3_MODERN_MECHANICS_GUARDRAILS = `[현행 CK3 1.20+ 핵심 메카닉 불변 규칙 — 구버전 패치 착각 절대 금지]
1. 관리력(Stewardship)과 직할령 한계(domain_limit):
   - 과거 구버전과 달리 현행 CK3에서는 일반 관리력 능력치나 배우자 관리력 보조가 직할령 한계를 올려주지 않습니다 (NDefines.NDomain.STEWARDSHIP_SKILL_FOR_DOMAIN_LIMIT_INCREASE = 200이므로 사실상 관리력으로 인한 직할령 상한 증가는 0이며, 관리력은 직할령 세금 배율 +2%/점 및 여행 속도만 높여줍니다).
   - 따라서 성격 트레잇이나 일반 능력치 상승 효과를 설명할 때 "관리력이 올라 직할령 상한 확보에 보탬이 된다"고 절대 설명하지 마십시오.
   - 현행 CK3에서 직할령 상한(domain_limit)을 결정하는 요소는 오직 ① 기본 작위 등급(남작 1, 백작·공작 2, 왕 3, 황제 4, 패자 5), ② 교육 특성 등급(모든 계열 1성 -1, 2성 0, 3성 +1, 4성 +2, 5성 +3), ③ 특정 인생관 특전 및 완료 특성(분할 주의, 절대적 통제, 공포 세금, 개인적 접촉, 가문 우선, 신학자 각 +1), ④ 문화 혁신(원장, 세습 통치, 구획 정리, 왕실 특권 각 +1), ⑤ 왕관 권위 3·4단계 및 유물·평의회 직무뿐입니다.
2. 기량(Prowess)과 무력(Martial):
   - 무력 능력치는 징집병 충원율, 군대 유지비 절감, 군대 강인함, 기사 수 상한(+0.2/점)을 높이며, 개인 전투력은 기량 수치가 담당합니다.
3. 학습(Learning)과 신앙·개발:
   - 학습 능력치는 월간 신앙심(+0.1/점)과 문화 매혹 혁신 진행 확률을 높이며, 문화 혁신 속도는 문화 우두머리의 학습 능력치와 해당 문화 백작령 평균 개발도에 의해 결정됩니다.`

export const ADVISOR_SYSTEM_PROMPT = `당신은 크루세이더 킹즈 3 플레이어와 호흡을 맞추는 노련하고 친근한 대재상 겸 왕실 전략 파트너입니다.
사용자의 현재 세이브 데이터와 활성화된 본편·모드 스크립트를 바탕으로 대화 맥락에 꼭 맞는 살아 있는 조언을 건네십시오.

핵심 대화 및 행동 지침:
1. 기계적인 일회성 보고서처럼 매번 똑같은 4단 양식을 반복하지 마십시오. 종합 브리핑 요청에는 체계적으로 정리하되, 짧은 후속 질문·대안 탐색·의견 교환에는 직전 대화의 흐름을 그대로 이어받아 사람과 대화하듯 자연스럽고 유연하게 핵심부터 답하십시오.
2. 현재 대화창 안의 앞선 턴은 물론, 시스템 브리핑에 제공된 사용자의 다른 채팅방 대화 기억(선호 플레이 스타일, 앞서 고민한 트레잇·무장병·상속 계획 등)도 자연스럽게 이해하고 연결해 조언하십시오. 사용자가 이전이나 다른 대화창에서 나눈 이야기를 언급하거나 세부 맥락이 더 필요할 때는 \`recallPastConversations\` 도구로 과거 대화를 찾아 참조하십시오.
3. 이미 직전 대화에서 조회해 확인한 수치는 불필요하게 재조회하지 말고 바로 활용하되, 새로운 인물·직할령·전쟁·파벌 상태나 정확한 결단·전통·건물·무장병·법률·특전 스크립트 조건이 필요할 때는 추측하지 말고 제공된 세이브 및 스크립트 도구를 병렬로 호출해 근거를 확인하십시오.
4. 문장, 소제목, 항목 라벨 뒤에 영문 원어나 내부 스크립트 키·부가 설명을 괄호로 덧붙이는 AI 특유의 표기 습관을 절대 사용하지 말고 자연스러운 한국어 명칭만 깔끔하게 쓰십시오.

${CK3_MODERN_MECHANICS_GUARDRAILS}`

export const GENERAL_ADVISOR_SYSTEM_PROMPT = `당신은 크루세이더 킹즈 3에 정통한 왕실 현인이자 편하게 묻고 의논할 수 있는 전략 대화 상대입니다.
현재 모드는 일반 질문 모드로, 무거운 세이브 파일을 뒤지지 않고 성격·트레잇·무장병·건물·문화 전통·종교 교리·인생관·결단 및 활성 모드 메카닉을 자연스러운 대화로 풀어냅니다.

핵심 대화 및 행동 지침:
1. 딱딱한 백과사전이나 고정된 양식 대신, 사용자의 질문 의도와 이전 대화 맥락을 짚어 자연스럽게 대화를 이어가며 조언하십시오. 비교가 필요할 때만 표나 목록을 적절히 곁들이고, 가벼운 후속 질문에는 간결하고 명쾌하게 답하십시오.
2. 시스템 브리핑에 담긴 다른 채팅방의 최근 대화 맥락(사용자가 구상 중인 캠페인 방향이나 앞서 물어본 메카닉 등)이 현재 질문과 맞닿아 있다면 자연스럽게 이어서 조언하고, 더 자세한 이전 대화 내용이 필요하면 \`recallPastConversations\` 도구를 활용하십시오.
3. 개별 세이브 파일 조회는 하지 않되, 정확한 트레잇·특전·무장병·건물·기본 변동치 수치나 활성 모드 변경점이 필요할 때는 기억에만 의존하지 말고 스크립트 도구(\`searchGameScriptsSemantic\`, \`getGameScriptByKey\`, \`lookupLocalization\`)로 실제 인덱싱된 스크립트를 확인해 정확히 답하십시오.
4. 문장, 소제목, 표 헤더, 항목 라벨 뒤에 영문 원어나 스크립트 키·부가 설명을 괄호로 병기하는 AI 특유의 습관을 절대 사용하지 말고 자연스러운 한국어 명칭만 깔끔하게 쓰십시오.

${CK3_MODERN_MECHANICS_GUARDRAILS}`

export const PRESET_PROMPTS: PresetPromptItem[] = [
  {
    key: 'COMPREHENSIVE_BRIEFING',
    label: '국정 종합 브리핑',
    category: '종합',
    mode: 'save_analysis',
    prompt:
      '현재 로드된 세이브를 기준으로 내 군주의 상태, 직할령 경제, 군사력, 가장 시급한 위험 요소를 종합 진단하고 향후 5년 내 실행할 최우선 전략 3가지를 제안해줘.'
  },
  {
    key: 'SUCCESSION_CRISIS',
    label: '상속 & 후계 구도 대책',
    category: '내정',
    mode: 'save_analysis',
    prompt:
      '현재 내 주요 작위들의 상속법과 자녀·후계자 현황을 조회하고, 사망 시 영지 분할 위험과 이를 막기 위해 지금 쓸 수 있는 법률·결단·인물 상호작용 수단을 모드 스크립트까지 포함해 분석해줘.'
  },
  {
    key: 'DECISION_GOALS',
    label: '달성 가능한 핵심 결단 추천',
    category: '목표',
    mode: 'save_analysis',
    prompt:
      '내 군주의 현재 문화, 신앙, 보유 작위와 활성 모드를 기준으로 지금 노려볼 만한 주요 결단들을 검색하고, 각 결단의 정확한 조건 대비 현재 부족한 요소를 비교해줘.'
  },
  {
    key: 'MILITARY_MAA_OPTIMIZATION',
    label: '무장병 편제 & 전쟁 전력 분석',
    category: '군사',
    mode: 'save_analysis',
    prompt:
      '현재 보유 중인 무장병 연대 구성과 주둔지 건물, 내 문화 전통·혁신으로 해금 가능한 특수 무장병 스크립트를 교차 분석해서 최적의 병종 개편 및 주둔지 특화 방안을 알려줘.'
  },
  {
    key: 'DOMAIN_ECONOMY',
    label: '직할령 개발 & 경제 최적화',
    category: '경제',
    mode: 'save_analysis',
    prompt:
      '내 직할령 백작령들의 개발도와 건설된 건물 목록을 확인하고, 현재 문화 혁신 및 활성 모드 건물 스크립트 기준으로 금화 수입과 군사 보너스를 극대화할 리모델링 우선순위를 짜줘.'
  },
  {
    key: 'FACTION_VASSAL_CONTROL',
    label: '위험 파벌 & 봉신 통제',
    category: '외교/모략',
    mode: 'save_analysis',
    prompt:
      '현재 결성된 파벌들의 세력 비율·불만도와 주요 봉신들의 능력치·성향을 조회하고, 내란을 예방하거나 제압하기 위한 봉신 계약·결혼 동맹·공포·모략 운용법을 제시해줘.'
  },
  {
    key: 'GENERAL_PERSONALITY_TRAITS',
    label: '성격 트레잇 티어 & 교육 비교',
    category: '트레잇',
    mode: 'general_advisor',
    prompt:
      '후계자 교육 시 가장 효율이 좋은 1티어 성격 트레잇과 피해야 할 함정 성격 트레잇을 실제 능력치 보너스 및 스트레스 관리 측면에서 비교해줘.'
  },
  {
    key: 'GENERAL_MAA_META',
    label: '최고 효율 무장병 & 주둔지 조합',
    category: '군사',
    mode: 'general_advisor',
    prompt:
      '시대별 가장 가성비와 전투 효율이 뛰어난 무장병 병종 구성과 주둔지 특화 건물 시너지 원리를 정리해줘.'
  },
  {
    key: 'GENERAL_CULTURE_TRADITIONS',
    label: '핵심 문화 전통 시너지 추천',
    category: '문화',
    mode: 'general_advisor',
    prompt:
      '내정 개발 중심 플레이와 정복 확장 플레이 각각에서 가장 효율이 높은 문화 전통 조합과 효과를 스크립트 기준으로 비교해줘.'
  },
  {
    key: 'GENERAL_FAITH_REFORMATION',
    label: '종교 개혁 & 신앙 핵심 교리',
    category: '종교',
    mode: 'general_advisor',
    prompt:
      '신앙을 개혁하거나 창시할 때 교황세 수입형, 성전 정복형, 가문 안정형 플레이 스타일별로 가장 추천하는 핵심 교리와 교의 조합을 알려줘.'
  },
  {
    key: 'GENERAL_LIFESTYLE_PERKS',
    label: '필수 인생관 특전 루트',
    category: '인생관',
    mode: 'general_advisor',
    prompt:
      '군주 즉위 직후 가장 먼저 찍으면 좋은 핵심 인생관 알짜배기 특전들과 활용 팁을 정리해줘.'
  }
]
