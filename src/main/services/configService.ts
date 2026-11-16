import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import * as R from 'remeda'
import {
  DEFAULT_EDGE_TTS_RATE,
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE
} from '@shared/constants'
import type { AppConfig, PublicAppSettings, UpdateSettingsPayload } from '@shared/types'
import { detectCk3Paths } from '@/main/services/pathDetector'

const CONFIG_FILE_NAME = 'config.json'
const ENCRYPTED_KEY_FILE_NAME = 'gemini_api_key.enc'
const LEGACY_B64_KEY_FILE_NAME = 'gemini_api_key.b64'
const ALLOWED_EMBEDDING_MODELS = new Set<string>([DEFAULT_EMBEDDING_MODEL])

/** `config.json` 경로별 인메모리 설정 캐시 (`reg.exe` 반복 동기 호출 방지 및 테스트 격리 보장) */
const appConfigCache = new Map<string, AppConfig>()

/** OS `safeStorage` 비가용 환경에서 디스크 평문 저장 대신 현재 세션 메모리에만 보관하는 키 맵 */
const volatileSessionApiKeys = new Map<string, string>()

/**
 * 포터블 `./data` 루트 디렉터리를 해석하고 하위 필수 폴더를 보장합니다.
 * @returns 포터블 데이터 루트 절대 경로
 */
export const getPortableDataDir = (): string => {
  const resolvePackagedBaseDir = (): string => {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      return process.env.PORTABLE_EXECUTABLE_DIR
    }
    if (process.platform === 'darwin') {
      return app.getPath('userData')
    }
    return path.dirname(app.getPath('exe'))
  }

  const baseDir = app?.isPackaged ? resolvePackagedBaseDir() : process.cwd()
  const dataDir = path.join(baseDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'tts_cache'), { recursive: true })
  return dataDir
}

/** TTS 오디오 캐시 디렉터리 경로를 반환합니다. */
export const getTtsCacheDir = (): string => path.join(getPortableDataDir(), 'tts_cache')

/** 바닐라 및 모드 VFS 통합 인덱스 SQLite 파일 경로를 반환합니다. */
export const getGameIndexDbPath = (): string => path.join(getPortableDataDir(), 'game_index.db')

/** 현재 불러온 세이브 판세 SQLite 파일 경로를 반환합니다. */
export const getSaveStateDbPath = (): string => path.join(getPortableDataDir(), 'save_state.db')

/** 로컬 ONNX 임베딩 모델 캐시 디렉터리 경로를 반환합니다. */
export const getModelsCacheDir = (): string => path.join(getPortableDataDir(), 'models')

/** 세이브 압축 해제 슬라이스 등 임시 파일 디렉터리 경로를 반환합니다. */
export const getTempDir = (): string => path.join(getPortableDataDir(), 'tmp')

const getConfigFilePath = (): string => path.join(getPortableDataDir(), CONFIG_FILE_NAME)

const getEncryptedKeyFilePath = (): string =>
  path.join(getPortableDataDir(), ENCRYPTED_KEY_FILE_NAME)

const getLegacyB64KeyFilePath = (): string =>
  path.join(getPortableDataDir(), LEGACY_B64_KEY_FILE_NAME)

const buildStaticDefaultConfig = (): Omit<
  AppConfig,
  'documentsDir' | 'steamInstallDir' | 'workshopDir'
> => ({
  selectedModel: DEFAULT_GEMINI_MODEL,
  embeddingModel: DEFAULT_EMBEDDING_MODEL,
  autoCheckVersionOnStartup: true,
  lastLoadedSavePath: '',
  ttsProvider: 'edge',
  edgeTtsVoice: DEFAULT_EDGE_TTS_VOICE,
  edgeTtsRate: DEFAULT_EDGE_TTS_RATE,
  geminiTtsModel: DEFAULT_GEMINI_TTS_MODEL,
  geminiTtsVoice: DEFAULT_GEMINI_TTS_VOICE,
  autoPlayTts: false
})

const createDefaultConfig = (): AppConfig => {
  const detected = detectCk3Paths()
  return {
    documentsDir: detected.documentsDir,
    steamInstallDir: detected.steamInstallDir,
    workshopDir: detected.workshopDir,
    ...buildStaticDefaultConfig()
  }
}

const normalizeSupportedModel = (rawModel?: string): string => {
  const trimmed = rawModel?.trim() ?? ''
  if (!trimmed || /^gemini-[12](\.|-|$)/i.test(trimmed)) {
    return DEFAULT_GEMINI_MODEL
  }
  return trimmed
}

const normalizeEmbeddingModel = (rawEmbeddingModel?: string): string => {
  const trimmed = rawEmbeddingModel?.trim() ?? ''
  return ALLOWED_EMBEDDING_MODELS.has(trimmed) ? trimmed : DEFAULT_EMBEDDING_MODEL
}

/**
 * 포터블 `config.json`에서 앱 설정을 불러오며, 파일이 이미 유효하면 무거운 레지스트리 경로 탐색을 생략합니다.
 * @returns 정규화된 애플리케이션 설정 객체
 */
export const loadAppConfig = (): AppConfig => {
  const configPath = getConfigFilePath()
  const cached = appConfigCache.get(configPath)
  if (cached && fs.existsSync(configPath)) {
    return { ...cached }
  }

  if (!fs.existsSync(configPath)) {
    const defaults = createDefaultConfig()
    saveAppConfig(defaults)
    return { ...defaults }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>
    const staticDefaults = buildStaticDefaultConfig()
    const needsPathFallback = !raw.documentsDir || !raw.steamInstallDir || !raw.workshopDir
    const detectedFallback = needsPathFallback ? detectCk3Paths() : null

    const normalizedModel = normalizeSupportedModel(raw.selectedModel)
    const normalizedEmbedding = normalizeEmbeddingModel(raw.embeddingModel)

    const merged: AppConfig = {
      documentsDir: raw.documentsDir || detectedFallback?.documentsDir || '',
      steamInstallDir: raw.steamInstallDir || detectedFallback?.steamInstallDir || '',
      workshopDir: raw.workshopDir || detectedFallback?.workshopDir || '',
      selectedModel: normalizedModel,
      embeddingModel: normalizedEmbedding,
      autoCheckVersionOnStartup:
        typeof raw.autoCheckVersionOnStartup === 'boolean'
          ? raw.autoCheckVersionOnStartup
          : staticDefaults.autoCheckVersionOnStartup,
      lastLoadedSavePath: raw.lastLoadedSavePath ?? '',
      ttsProvider: raw.ttsProvider === 'gemini' ? 'gemini' : 'edge',
      edgeTtsVoice: raw.edgeTtsVoice || staticDefaults.edgeTtsVoice,
      edgeTtsRate: raw.edgeTtsRate || staticDefaults.edgeTtsRate,
      geminiTtsModel: raw.geminiTtsModel || staticDefaults.geminiTtsModel,
      geminiTtsVoice: raw.geminiTtsVoice || staticDefaults.geminiTtsVoice,
      autoPlayTts:
        typeof raw.autoPlayTts === 'boolean' ? raw.autoPlayTts : staticDefaults.autoPlayTts
    }

    if (raw.selectedModel !== normalizedModel || raw.embeddingModel !== normalizedEmbedding) {
      saveAppConfig(merged)
    } else {
      appConfigCache.set(configPath, merged)
    }
    return { ...merged }
  } catch {
    const defaults = createDefaultConfig()
    saveAppConfig(defaults)
    return { ...defaults }
  }
}

/**
 * 애플리케이션 설정을 원자적으로 `config.json`에 저장하고 인메모리 캐시를 갱신합니다.
 * @param config 저장할 설정 객체
 * @returns 저장된 설정 객체
 */
export const saveAppConfig = (config: AppConfig): AppConfig => {
  const configPath = getConfigFilePath()
  const tempPath = `${configPath}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf8')
  fs.renameSync(tempPath, configPath)
  appConfigCache.set(configPath, { ...config })
  return config
}

const cleanupLegacyPlainKeyFile = (): void => {
  const legacyPath = getLegacyB64KeyFilePath()
  if (fs.existsSync(legacyPath)) {
    try {
      fs.unlinkSync(legacyPath)
    } catch {
      // 삭제 실패 무시
    }
  }
}

/**
 * Gemini API 키를 OS `safeStorage`로 암호화하여 저장합니다.
 * 암호화가 비활성인 환경에서는 디스크에 평문/Base64를 기록하지 않고 현재 실행 세션 메모리에만 유지합니다.
 * @param plainApiKey 저장할 원본 API 키 문자열 (빈 문자열이면 삭제)
 */
export const saveGeminiApiKey = (plainApiKey: string): void => {
  const trimmed = plainApiKey.trim()
  const encPath = getEncryptedKeyFilePath()
  cleanupLegacyPlainKeyFile()

  if (!trimmed) {
    volatileSessionApiKeys.delete(encPath)
    if (fs.existsSync(encPath)) fs.unlinkSync(encPath)
    return
  }

  if (safeStorage?.isEncryptionAvailable?.()) {
    const encryptedBuffer = safeStorage.encryptString(trimmed)
    fs.writeFileSync(encPath, encryptedBuffer)
    volatileSessionApiKeys.delete(encPath)
  } else {
    volatileSessionApiKeys.set(encPath, trimmed)
  }
}

/**
 * 암호화 저장소, 세션 메모리, 환경 변수 순으로 유효한 Gemini API 키를 복호화해 반환합니다.
 * @returns 복호화된 API 키 문자열 (없으면 빈 문자열)
 */
export const loadGeminiApiKey = (): string => {
  const encPath = getEncryptedKeyFilePath()
  cleanupLegacyPlainKeyFile()

  try {
    if (fs.existsSync(encPath) && safeStorage?.isEncryptionAvailable?.()) {
      const encryptedBuffer = fs.readFileSync(encPath)
      return safeStorage.decryptString(encryptedBuffer).trim()
    }
  } catch {
    return ''
  }

  const sessionKey = volatileSessionApiKeys.get(encPath)
  if (sessionKey) {
    return sessionKey
  }

  return process.env.GEMINI_API_KEY?.trim() ?? ''
}

const maskApiKey = (apiKey: string): string => {
  if (!apiKey) return ''
  if (apiKey.length <= 8) return '••••••••'
  return `${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}`
}

/**
 * 예외 메시지나 로그 문자열에 포함될 수 있는 Gemini API 키 및 URL 인코딩 토큰을 안전하게 마스킹합니다.
 * @param rawMessage 원본 에러 또는 로그 문자열
 * @param explicitApiKey 호출 시점에 사용된 명시적 API 키
 * @returns 민감 토큰이 마스킹된 문자열
 */
export const sanitizeSensitiveText = (rawMessage: string, explicitApiKey?: string): string => {
  let sanitized = rawMessage.replace(/AIza[0-9A-Za-z_-]{16,}/g, 'AIza••••••••REDACTED')
  const candidateKey = explicitApiKey?.trim()
  if (candidateKey && candidateKey.length >= 6) {
    sanitized = sanitized.replaceAll(candidateKey, maskApiKey(candidateKey))
    const encoded = encodeURIComponent(candidateKey)
    if (encoded !== candidateKey) {
      sanitized = sanitized.replaceAll(encoded, maskApiKey(candidateKey))
    }
  }
  return sanitized
}

/**
 * 렌더러에 안전하게 노출 가능한 공개 설정 정보와 마스킹된 API 키 상태를 반환합니다.
 * @returns 공개 앱 설정 객체
 */
export const getPublicSettings = (): PublicAppSettings => {
  const config = loadAppConfig()
  const apiKey = loadGeminiApiKey()

  return {
    config,
    hasApiKey: apiKey.length > 0,
    maskedApiKey: maskApiKey(apiKey),
    dataDir: getPortableDataDir(),
    encryptionAvailable: Boolean(safeStorage?.isEncryptionAvailable?.())
  }
}

/**
 * 부분 업데이트 페이로드를 병합하여 설정 및 암호화 API 키를 갱신합니다.
 * @param payload 변경할 설정 필드 모음
 * @returns 갱신된 공개 설정 객체
 */
export const updateAppSettings = (payload: UpdateSettingsPayload): PublicAppSettings => {
  const current = loadAppConfig()

  const pickedUpdates = R.pipe(
    {
      documentsDir: payload.documentsDir,
      steamInstallDir: payload.steamInstallDir,
      workshopDir: payload.workshopDir,
      selectedModel:
        payload.selectedModel !== undefined
          ? normalizeSupportedModel(payload.selectedModel)
          : undefined,
      embeddingModel:
        payload.embeddingModel !== undefined
          ? normalizeEmbeddingModel(payload.embeddingModel)
          : undefined,
      autoCheckVersionOnStartup: payload.autoCheckVersionOnStartup,
      ttsProvider: payload.ttsProvider,
      edgeTtsVoice: payload.edgeTtsVoice,
      edgeTtsRate: payload.edgeTtsRate,
      geminiTtsModel: payload.geminiTtsModel,
      geminiTtsVoice: payload.geminiTtsVoice,
      autoPlayTts: payload.autoPlayTts
    },
    R.pickBy((val) => val !== undefined)
  )

  const updatedConfig: AppConfig = {
    ...current,
    ...pickedUpdates
  }

  saveAppConfig(updatedConfig)

  if (payload.clearApiKey) {
    saveGeminiApiKey('')
  } else if (typeof payload.apiKey === 'string' && payload.apiKey.trim().length > 0) {
    saveGeminiApiKey(payload.apiKey)
  }

  return getPublicSettings()
}

/**
 * 마지막으로 성공적으로 파싱한 `.ck3` 세이브 경로를 설정에 기록합니다.
 * @param savePath 세이브 파일 절대 경로
 */
export const recordLastLoadedSavePath = (savePath: string): void => {
  const current = loadAppConfig()
  saveAppConfig({
    ...current,
    lastLoadedSavePath: savePath
  })
}
