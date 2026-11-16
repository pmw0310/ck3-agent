import fs from 'node:fs'
import path from 'node:path'
import * as R from 'remeda'
import type { ChatMessage, ChatSession } from '@shared/types'
import { getPortableDataDir } from '@/main/services/configService'

const CHAT_SESSIONS_FILE_NAME = 'chat_sessions.json'
const MAX_STORED_SESSIONS = 120
const MAX_MESSAGES_PER_SESSION = 300
const MAX_MESSAGE_CONTENT_LENGTH = 60_000

/** 세션 파일 경로별 Read-through 메모리 캐시 */
const sessionsMemoryCache = new Map<string, ChatSession[]>()

const getChatSessionsFilePath = (): string =>
  path.join(getPortableDataDir(), CHAT_SESSIONS_FILE_NAME)

const sanitizeChatMessage = (raw: ChatMessage): ChatMessage | null => {
  if (!raw || typeof raw.id !== 'string' || typeof raw.content !== 'string') {
    return null
  }
  return {
    id: raw.id.slice(0, 120),
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    content: raw.content.slice(0, MAX_MESSAGE_CONTENT_LENGTH),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    modeUsed:
      raw.modeUsed === 'general_advisor'
        ? 'general_advisor'
        : raw.modeUsed === 'save_analysis'
          ? 'save_analysis'
          : undefined,
    modelUsed: typeof raw.modelUsed === 'string' ? raw.modelUsed.slice(0, 120) : undefined,
    toolSteps: Array.isArray(raw.toolSteps) ? raw.toolSteps.slice(0, 40) : undefined,
    isError: Boolean(raw.isError)
  }
}

const sanitizeChatSessionInput = (item: ChatSession): ChatSession | null => {
  if (!item || typeof item.id !== 'string' || !Array.isArray(item.messages)) {
    return null
  }
  const cleanMessages = R.pipe(
    item.messages,
    R.map(sanitizeChatMessage),
    R.filter((m): m is ChatMessage => m !== null),
    (arr) => arr.slice(-MAX_MESSAGES_PER_SESSION)
  )

  return {
    id: item.id.slice(0, 120),
    title: item.title?.trim().slice(0, 160) || '새 대화',
    mode: item.mode === 'general_advisor' ? 'general_advisor' : 'save_analysis',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    parentSessionId:
      typeof item.parentSessionId === 'string' ? item.parentSessionId.slice(0, 120) : undefined,
    saveContextLabel:
      typeof item.saveContextLabel === 'string' ? item.saveContextLabel.slice(0, 200) : undefined,
    messages: cleanMessages
  }
}

/**
 * 포터블 `./data/chat_sessions.json`에 저장된 모든 채팅 세션 목록을 최신 수정순으로 불러옵니다.
 * @returns 최신순으로 정렬된 채팅 세션 배열
 */
export const listChatSessions = (): ChatSession[] => {
  const filePath = getChatSessionsFilePath()
  const cached = sessionsMemoryCache.get(filePath)
  if (cached && fs.existsSync(filePath)) {
    return cached
  }

  if (!fs.existsSync(filePath)) {
    sessionsMemoryCache.delete(filePath)
    return []
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []

    const loaded = R.pipe(
      raw as ChatSession[],
      R.map(sanitizeChatSessionInput),
      R.filter((item): item is ChatSession => item !== null),
      R.sortBy([(item) => item.updatedAt, 'desc']),
      R.take(MAX_STORED_SESSIONS)
    )
    sessionsMemoryCache.set(filePath, loaded)
    return loaded
  } catch {
    return []
  }
}

const writeChatSessions = (sessions: ChatSession[]): ChatSession[] => {
  const sorted = R.pipe(
    sessions,
    R.sortBy([(item) => item.updatedAt, 'desc']),
    R.take(MAX_STORED_SESSIONS)
  )
  const filePath = getChatSessionsFilePath()
  const tempPath = `${filePath}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(sorted, null, 2), 'utf8')
  fs.renameSync(tempPath, filePath)
  sessionsMemoryCache.set(filePath, sorted)
  return sorted
}

/**
 * 단일 채팅 세션을 생성 또는 갱신(Upsert)하고 정렬된 전체 세션 목록을 반환합니다.
 * @param session 저장할 채팅 세션 엔티티
 * @returns 갱신된 전체 채팅 세션 배열
 */
export const saveChatSession = (session: ChatSession): ChatSession[] => {
  const sanitized = sanitizeChatSessionInput(session)
  const existing = listChatSessions()
  if (!sanitized) {
    return existing
  }
  const filtered = R.pipe(
    existing,
    R.filter((item) => item.id !== sanitized.id)
  )
  return writeChatSessions([sanitized, ...filtered])
}

/**
 * 특정 채팅 세션을 삭제하고 남은 세션 목록을 반환합니다.
 * @param sessionId 삭제할 세션 고유 ID
 * @returns 갱신된 전체 채팅 세션 배열
 */
export const deleteChatSession = (sessionId: string): ChatSession[] => {
  const existing = listChatSessions()
  const remaining = R.pipe(
    existing,
    R.filter((item) => item.id !== sessionId)
  )
  return writeChatSessions(remaining)
}

const compactSnippet = (raw: string, maxLen: number): string => {
  const cleaned = raw
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned
}

/**
 * 현재 대화창 이외의 최근 다른 채팅 세션들에서 핵심 질문과 조언 요약을 추출하여
 * 에이전트가 대화방 간 맥락을 자연스럽게 이어받을 수 있는 브리핑 문자열을 생성합니다.
 * @param excludeSessionId 현재 진행 중인 세션 ID
 * @returns 다른 대화방 맥락 요약 문자열
 */
export const buildCrossSessionMemoryDigest = (excludeSessionId?: string): string => {
  const otherSessions = R.pipe(
    listChatSessions(),
    R.filter((s) => s.id !== excludeSessionId && s.messages.some((m) => !m.isError)),
    R.take(6)
  )

  if (otherSessions.length === 0) {
    return ''
  }

  const lines = R.pipe(
    otherSessions,
    R.map((session) => {
      const validMsgs = session.messages.filter((m) => !m.isError)
      const recentSlice = validMsgs.slice(-4)
      const modeTag = session.mode === 'general_advisor' ? '일반 현인 대화' : '세이브 판세 대화'
      const contextTag = session.saveContextLabel ? ` · ${session.saveContextLabel}` : ''
      const turnsSummary = R.pipe(
        recentSlice,
        R.map((m) =>
          m.role === 'user'
            ? `  - 사용자: ${compactSnippet(m.content, 110)}`
            : `  - 조언 요약: ${compactSnippet(m.content, 200)}`
        )
      ).join('\n')

      return `• 대화 제목: "${session.title}" [${modeTag}${contextTag}]\n${turnsSummary}`
    })
  )

  return [
    '[사용자의 다른 채팅방 최근 대화 기억 — 맥락 연결 참고용]',
    '아래는 사용자가 다른 대화창에서 나눈 최근 질문과 조언 요약입니다. 현재 질문이 이전 대화의 고민·전략 방향과 연관될 때 자연스럽게 맥락을 이어서 조언하되, 관련 없는 주제라면 억지로 언급하지 마십시오. 더 구체적인 과거 대화 원문이 필요하면 `recallPastConversations` 도구를 호출하십시오.',
    ...lines
  ].join('\n')
}

export interface PastConversationMatch {
  sessionId: string
  title: string
  mode: string
  saveContextLabel?: string
  updatedAt: string
  excerpts: Array<{ role: 'user' | 'assistant'; text: string }>
}

/**
 * 저장된 다른 채팅 세션들의 대화 내용을 키워드로 검색하거나 최신 대화를 상세 조회합니다.
 * @param params 검색어, 제외할 현재 세션 ID, 최대 반환 수
 * @returns 매칭된 과거 대화 세션 및 발췌 목록
 */
export const searchPastChatSessions = (params: {
  query?: string
  excludeSessionId?: string
  limit?: number
}): PastConversationMatch[] => {
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 12)
  const keywords = R.pipe(
    (params.query ?? '').toLowerCase().split(/\s+/),
    R.map((k) => k.trim()),
    R.filter((k) => k.length >= 2)
  )

  const candidates = R.pipe(
    listChatSessions(),
    R.filter((s) => s.id !== params.excludeSessionId && s.messages.some((m) => !m.isError))
  )

  if (candidates.length === 0) return []

  const scored = R.pipe(
    candidates,
    R.map((session) => {
      const validMessages = session.messages.filter((m) => !m.isError)
      if (keywords.length === 0) {
        return {
          session,
          score: 1,
          matchedMessages: validMessages.slice(-6)
        }
      }

      const titleLower = `${session.title} ${session.saveContextLabel ?? ''}`.toLowerCase()
      let score = 0
      for (const kw of keywords) {
        if (titleLower.includes(kw)) score += 3
      }

      const matchedMessages = validMessages.filter((msg) => {
        const lower = msg.content.toLowerCase()
        const hit = keywords.some((kw) => lower.includes(kw))
        if (hit) score += 2
        return hit
      })

      return {
        session,
        score,
        matchedMessages: matchedMessages.length > 0 ? matchedMessages.slice(-6) : validMessages.slice(-4)
      }
    }),
    R.filter((entry) => (keywords.length > 0 ? entry.score > 0 : true)),
    R.sortBy([(entry) => entry.score, 'desc'], [(entry) => entry.session.updatedAt, 'desc']),
    R.take(limit)
  )

  return R.pipe(
    scored,
    R.map(({ session, matchedMessages }) => ({
      sessionId: session.id,
      title: session.title,
      mode: session.mode === 'general_advisor' ? '일반 현인 자문' : '세이브 판세 분석',
      saveContextLabel: session.saveContextLabel,
      updatedAt: session.updatedAt,
      excerpts: matchedMessages.map((m) => ({
        role: m.role,
        text: compactSnippet(m.content, 700)
      }))
    }))
  )
}
