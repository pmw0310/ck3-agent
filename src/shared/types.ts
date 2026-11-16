/**
 * 지원하는 음성 합성 엔진 구분
 * - `edge`: API 키가 필요 없는 무료 Microsoft Edge 신경망 TTS
 * - `gemini`: Google Gemini 전용 TTS 모델
 */
export type TtsProvider = 'edge' | 'gemini'

export type EdgeTtsVoice =
  | 'ko-KR-InJoonNeural'
  | 'ko-KR-HyunsuNeural'
  | 'ko-KR-SunHiNeural'

export type GeminiTtsModel =
  | 'gemini-3.8-flash-tts'
  | 'gemini-3.8-flash-lite-tts'

export type GeminiTtsVoice =
  | 'Charon'
  | 'Fenrir'
  | 'Kore'
  | 'Aoede'
  | 'Puck'
  | 'Algenib'

/** 자동 탐색된 CK3 설치·문서·창작마당·세이브·모드 디렉터리 경로 모음 */
export interface DetectedPaths {
  documentsDir: string
  steamInstallDir: string
  workshopDir: string
  saveGamesDir: string
  modsDir: string
}

/** 포터블 `./data/config.json`에 영속화되는 애플리케이션 설정 스키마 */
export interface AppConfig {
  documentsDir: string
  steamInstallDir: string
  workshopDir: string
  selectedModel: string
  embeddingModel: string
  autoCheckVersionOnStartup: boolean
  lastLoadedSavePath: string
  ttsProvider: TtsProvider
  edgeTtsVoice: EdgeTtsVoice
  edgeTtsRate: string
  geminiTtsModel: GeminiTtsModel
  geminiTtsVoice: GeminiTtsVoice
  autoPlayTts: boolean
}

export interface PublicAppSettings {
  config: AppConfig
  hasApiKey: boolean
  maskedApiKey: string
  dataDir: string
  encryptionAvailable: boolean
}

export interface UpdateSettingsPayload {
  documentsDir?: string
  steamInstallDir?: string
  workshopDir?: string
  selectedModel?: string
  embeddingModel?: string
  autoCheckVersionOnStartup?: boolean
  ttsProvider?: TtsProvider
  edgeTtsVoice?: EdgeTtsVoice
  edgeTtsRate?: string
  geminiTtsModel?: GeminiTtsModel
  geminiTtsVoice?: GeminiTtsVoice
  autoPlayTts?: boolean
  apiKey?: string
  clearApiKey?: boolean
}

export interface ModDescriptor {
  modFileRelPath: string
  name: string
  version: string
  supportedVersion: string
  resolvedPath: string
  isArchive: boolean
  remoteFileId: string
  replacePaths: string[]
  mtimeMs: number
  exists: boolean
}

export interface VersionSnapshot {
  fingerprintHash: string
  baseGameVersion: string
  rawGameVersion: string
  activePlaysetName: string
  enabledMods: ModDescriptor[]
  capturedAt: string
}

export interface VersionDiffSummary {
  isFirstIndex: boolean
  baseVersionChanged: boolean
  previousBaseVersion: string | null
  currentBaseVersion: string
  playsetChanged: boolean
  previousPlaysetName: string | null
  currentPlaysetName: string
  addedMods: string[]
  removedMods: string[]
  updatedMods: string[]
  orderChanged: boolean
}

export interface VersionCheckResult {
  needsReindex: boolean
  reasonSummary: string
  currentSnapshot: VersionSnapshot
  storedSnapshot: VersionSnapshot | null
  diff: VersionDiffSummary
  indexedScriptCount: number
  indexedLocCount: number
  pathsValid: boolean
  missingPaths: string[]
}

export type IndexPhase =
  | 'idle'
  | 'scanning-vfs'
  | 'parsing-localization'
  | 'parsing-scripts'
  | 'loading-embedder'
  | 'embedding-vectors'
  | 'committing-db'
  | 'completed'
  | 'cancelled'
  | 'error'

export interface IndexProgressPayload {
  phase: IndexPhase
  percent: number
  message: string
  currentItem?: string
  processedCount: number
  totalCount: number
  error?: string
}

export type SaveParsePhase =
  | 'idle'
  | 'extracting'
  | 'scanning-sections'
  | 'parsing-jomini'
  | 'writing-db'
  | 'completed'
  | 'error'

export interface SaveProgressPayload {
  phase: SaveParsePhase
  percent: number
  message: string
  processedCount: number
  totalCount: number
  error?: string
}

export interface RulerSkills {
  diplomacy: number
  martial: number
  stewardship: number
  intrigue: number
  learning: number
  prowess: number
}

export interface SaveSummary {
  filePath: string
  fileName: string
  parsedAt: string
  gameDate: string
  saveGameVersion: string
  playerCharacterId: number
  playerName: string
  houseName: string
  dynastyName: string
  primaryTitleKey: string
  primaryTitleName: string
  governmentType: string
  faithName: string
  cultureName: string
  age: number
  stress: number
  gold: number
  monthlyIncome: number
  prestige: number
  piety: number
  renown: number
  dread: number
  militaryStrength: number
  domainCount: number
  vassalCount: number
  activeWarCount: number
  dangerousFactionCount: number
  skills: RulerSkills
  traits: string[]
  saveMods: string[]
}

/**
 * 에이전트 대화 모드 구분
 * - `save_analysis`: 로드된 .ck3 세이브 DB + VFS 스크립트 교차 정밀 판세 분석 모드
 * - `general_advisor`: 세이브 DB 조회를 생략하고 CK3 메카닉·트레잇·모드 스크립트만 빠르게 답하는 현인 자문 모드
 */
export type ChatMode = 'save_analysis' | 'general_advisor'

export type ToolStepStatus = 'running' | 'completed' | 'error'

export interface ToolExecutionStep {
  id: string
  toolName: string
  displayTitle: string
  args: Record<string, unknown>
  status: ToolStepStatus
  resultSummary?: string
  durationMs?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  modeUsed?: ChatMode
  modelUsed?: string
  toolSteps?: ToolExecutionStep[]
  isError?: boolean
}

/**
 * 영구 보관 및 분기 가능한 개별 채팅 세션 엔티티
 */
export interface ChatSession {
  id: string
  title: string
  mode: ChatMode
  createdAt: string
  updatedAt: string
  saveContextLabel?: string
  parentSessionId?: string
  messages: ChatMessage[]
}

export interface PresetPromptItem {
  key: string
  label: string
  category: string
  mode: ChatMode
  prompt: string
}

export interface GeminiModelOption {
  id: string
  displayName: string
  description?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant'
  content: string
  toolNotes?: string
}

export interface ChatRequestPayload {
  message: string
  history: ChatHistoryTurn[]
  requestId: string
  mode?: ChatMode
  sessionId?: string
}

export interface AgentToolStepEvent {
  requestId: string
  step: ToolExecutionStep
}

/**
 * Gemini SSE(`streamGenerateContent?alt=sse`) 텍스트 스트리밍 청크 이벤트
 */
export interface AgentStreamChunkEvent {
  requestId: string
  deltaText: string
  accumulatedText: string
  isDone?: boolean
  aborted?: boolean
}

export interface ChatResponsePayload {
  requestId: string
  reply: string
  modelUsed: string
  toolSteps: ToolExecutionStep[]
  aborted?: boolean
}

export interface IndexStartResult {
  started: boolean
  message: string
}

export interface SaveLoadResult {
  success: boolean
  summary: SaveSummary | null
  error?: string
}

export interface TtsSynthesizePayload {
  text: string
  providerOverride?: TtsProvider
  edgeVoiceOverride?: EdgeTtsVoice
  edgeRateOverride?: string
  geminiModelOverride?: GeminiTtsModel
  geminiVoiceOverride?: GeminiTtsVoice
}

export interface TtsSynthesizeResult {
  success: boolean
  audioBase64?: string
  mimeType?: string
  usedFallback?: boolean
  fallbackReason?: string
  error?: string
}

export interface Ck3Api {
  getSettings: () => Promise<PublicAppSettings>
  updateSettings: (payload: UpdateSettingsPayload) => Promise<PublicAppSettings>
  autoDetectPaths: () => Promise<DetectedPaths>
  selectDirectory: (title: string, defaultPath?: string) => Promise<string | null>
  selectSaveFile: (defaultPath?: string) => Promise<string | null>
  checkVersion: () => Promise<VersionCheckResult>
  startIndexing: (force?: boolean) => Promise<IndexStartResult>
  cancelIndexing: () => Promise<void>
  loadLatestSave: () => Promise<SaveLoadResult>
  loadSaveByPath: (savePath: string) => Promise<SaveLoadResult>
  getCurrentSaveSummary: () => Promise<SaveSummary | null>
  listGeminiModels: (overrideApiKey?: string) => Promise<GeminiModelOption[]>
  sendChatMessage: (payload: ChatRequestPayload) => Promise<ChatResponsePayload>
  cancelChatMessage: (requestId: string) => Promise<void>
  listChatSessions: () => Promise<ChatSession[]>
  saveChatSession: (session: ChatSession) => Promise<ChatSession[]>
  deleteChatSession: (sessionId: string) => Promise<ChatSession[]>
  synthesizeTts: (payload: TtsSynthesizePayload) => Promise<TtsSynthesizeResult>
  onIndexProgress: (callback: (payload: IndexProgressPayload) => void) => () => void
  onSaveProgress: (callback: (payload: SaveProgressPayload) => void) => () => void
  onVersionCheckResult: (callback: (result: VersionCheckResult) => void) => () => void
  onAgentToolStep: (callback: (event: AgentToolStepEvent) => void) => () => void
  onAgentStreamChunk: (callback: (event: AgentStreamChunkEvent) => void) => () => void
}
