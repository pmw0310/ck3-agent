import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import indexWorkerPath from '../workers/indexWorker?modulePath'
import saveWorkerPath from '../workers/saveWorker?modulePath'
import { DEFAULT_EMBEDDING_MODEL, IPC_CHANNELS } from '@shared/constants'
import type {
  ChatRequestPayload,
  ChatSession,
  IndexProgressPayload,
  IndexStartResult,
  SaveLoadResult,
  SaveProgressPayload,
  SaveSummary,
  TtsSynthesizePayload,
  UpdateSettingsPayload
} from '@shared/types'
import {
  getGameIndexDbPath,
  getModelsCacheDir,
  getPublicSettings,
  getSaveStateDbPath,
  getTempDir,
  loadAppConfig,
  recordLastLoadedSavePath,
  updateAppSettings
} from '@/main/services/configService'
import { detectCk3Paths, findLatestSaveFile } from '@/main/services/pathDetector'
import {
  checkGameAndModVersion
} from '@/main/services/versionWatcher'
import {
  getCurrentSaveSummary,
  refreshIndexDbConnection,
  refreshSaveDbConnection
} from '@/main/services/dbService'
import {
  cancelAdvisorChatTurn,
  listAvailableGeminiModels,
  runAdvisorChatTurn
} from '@/main/services/agentService'
import {
  deleteChatSession,
  listChatSessions,
  saveChatSession
} from '@/main/services/chatSessionService'
import { synthesizeAdvisorSpeech } from '@/main/services/ttsService'
import type { IndexWorkerData } from '@/main/workers/indexWorker'
import type { SaveWorkerData } from '@/main/workers/saveWorker'

let activeIndexWorker: Worker | null = null
let activeSaveWorker: Worker | null = null

const MAX_SAVE_FILE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * 활성 모든 렌더러 창에 비동기 IPC 이벤트를 브로드캐스트합니다.
 * @param channel 전송할 IPC 채널 이름
 * @param payload 전달할 이벤트 페이로드
 */
export const broadcastToRenderer = <T>(channel: string, payload: T): void => {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

const validateSaveFilePath = (rawPath: string): string | null => {
  if (!rawPath || typeof rawPath !== 'string') {
    return '선택한 세이브 파일 경로가 비어 있습니다.'
  }
  const normalized = path.resolve(rawPath)
  if (!normalized.toLowerCase().endsWith('.ck3')) {
    return '유효한 .ck3 세이브 파일만 불러올 수 있습니다.'
  }
  if (!fs.existsSync(normalized)) {
    return '선택한 세이브 파일이 존재하지 않습니다.'
  }
  try {
    const stat = fs.statSync(normalized)
    if (!stat.isFile()) {
      return '선택한 경로가 일반 파일이 아닙니다.'
    }
    if (stat.size <= 0 || stat.size > MAX_SAVE_FILE_BYTES) {
      return '세이브 파일 크기가 비정상적이거나 허용 상한을 초과했습니다.'
    }
  } catch {
    return '세이브 파일 정보를 읽을 수 없습니다.'
  }
  return null
}

const resolveWorkerScriptPath = (bundledPath: string): string =>
  bundledPath.includes('app.asar') && !bundledPath.includes('app.asar.unpacked')
    ? bundledPath.replace('app.asar', 'app.asar.unpacked')
    : bundledPath

const executeSaveLoadWorker = (saveFilePath: string): Promise<SaveLoadResult> =>
  new Promise((resolve) => {
    if (activeSaveWorker) {
      resolve({
        success: false,
        summary: null,
        error: '이미 다른 세이브 파일을 분석하고 있습니다. 잠시만 기다려 주세요.'
      })
      return
    }

    const workerInput: SaveWorkerData = {
      saveFilePath,
      saveStateDbPath: getSaveStateDbPath(),
      gameIndexDbPath: getGameIndexDbPath(),
      tempDir: getTempDir()
    }

    const worker = new Worker(resolveWorkerScriptPath(saveWorkerPath), {
      workerData: workerInput
    })
    activeSaveWorker = worker

    let resolved = false

    worker.on(
      'message',
      (msg: {
        type: 'progress' | 'result' | 'error'
        payload?: SaveProgressPayload
        summary?: SaveSummary
        error?: string
      }) => {
        if (msg.type === 'progress' && msg.payload) {
          broadcastToRenderer(IPC_CHANNELS.EVENT_SAVE_PROGRESS, msg.payload)
        } else if (msg.type === 'result' && msg.summary && !resolved) {
          resolved = true
          refreshSaveDbConnection()
          recordLastLoadedSavePath(saveFilePath)
          resolve({ success: true, summary: msg.summary })
        } else if (msg.type === 'error' && !resolved) {
          resolved = true
          resolve({
            success: false,
            summary: null,
            error: msg.error || '세이브 파싱 중 알 수 없는 오류가 발생했습니다.'
          })
        }
      }
    )

    worker.on('error', (err) => {
      activeSaveWorker = null
      if (!resolved) {
        resolved = true
        broadcastToRenderer<SaveProgressPayload>(IPC_CHANNELS.EVENT_SAVE_PROGRESS, {
          phase: 'error',
          percent: 0,
          message: err.message,
          processedCount: 0,
          totalCount: 0,
          error: err.message
        })
        resolve({ success: false, summary: null, error: err.message })
      }
    })

    worker.on('exit', (code) => {
      activeSaveWorker = null
      if (!resolved) {
        resolved = true
        resolve({
          success: false,
          summary: getCurrentSaveSummary(),
          error:
            code !== 0 ? `세이브 워커가 비정상 종료되었습니다 (코드: ${code})` : undefined
        })
      }
    })
  })

/**
 * 앱 시작 직후 게임 버전 및 활성 모드 변경 여부를 점검하여 렌더러에 알립니다.
 */
export const triggerStartupVersionCheck = (): void => {
  const config = loadAppConfig()
  if (!config.autoCheckVersionOnStartup) return
  const checkResult = checkGameAndModVersion(config)
  broadcastToRenderer(IPC_CHANNELS.EVENT_VERSION_CHECK, checkResult)
}

/**
 * 메인 프로세스의 모든 IPC 요청 핸들러를 등록합니다.
 */
export const registerIpcHandlers = (): void => {
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => getPublicSettings())

  ipcMain.handle(IPC_CHANNELS.UPDATE_SETTINGS, (_event, payload: UpdateSettingsPayload) => {
    const updated = updateAppSettings(payload)
    const versionResult = checkGameAndModVersion(updated.config)
    broadcastToRenderer(IPC_CHANNELS.EVENT_VERSION_CHECK, versionResult)
    return updated
  })

  ipcMain.handle(IPC_CHANNELS.AUTO_DETECT_PATHS, () => detectCk3Paths())

  ipcMain.handle(
    IPC_CHANNELS.SELECT_DIRECTORY,
    async (event, title: string, defaultPath?: string) => {
      const parentWin = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: title || '폴더 선택',
        defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
        properties: ['openDirectory']
      }
      const result = parentWin
        ? await dialog.showOpenDialog(parentWin, options)
        : await dialog.showOpenDialog(options)

      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  ipcMain.handle(IPC_CHANNELS.SELECT_SAVE_FILE, async (event, defaultPath?: string) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender)
    const config = loadAppConfig()
    const fallbackSaveDir = config.documentsDir
      ? path.join(config.documentsDir, 'save games')
      : undefined
    const initialDir =
      defaultPath && fs.existsSync(defaultPath)
        ? defaultPath
        : fallbackSaveDir && fs.existsSync(fallbackSaveDir)
          ? fallbackSaveDir
          : undefined

    const options: Electron.OpenDialogOptions = {
      title: 'CK3 세이브 파일 선택',
      defaultPath: initialDir,
      filters: [{ name: 'Crusader Kings III Save', extensions: ['ck3'] }],
      properties: ['openFile']
    }

    const result = parentWin
      ? await dialog.showOpenDialog(parentWin, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.CHECK_VERSION, () => {
    const config = loadAppConfig()
    const result = checkGameAndModVersion(config)
    broadcastToRenderer(IPC_CHANNELS.EVENT_VERSION_CHECK, result)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.START_INDEXING, (_event, _force?: boolean): IndexStartResult => {
    if (activeIndexWorker) {
      return {
        started: false,
        message: '이미 인덱싱 작업이 백그라운드에서 진행 중입니다.'
      }
    }

    const config = loadAppConfig()
    const versionCheck = checkGameAndModVersion(config)
    if (!versionCheck.pathsValid) {
      return {
        started: false,
        message: versionCheck.reasonSummary
      }
    }

    const workerInput: IndexWorkerData = {
      gameIndexDbPath: getGameIndexDbPath(),
      modelsCacheDir: getModelsCacheDir(),
      steamInstallDir: config.steamInstallDir,
      embeddingModel: config.embeddingModel || DEFAULT_EMBEDDING_MODEL,
      versionSnapshot: versionCheck.currentSnapshot
    }

    const worker = new Worker(resolveWorkerScriptPath(indexWorkerPath), {
      workerData: workerInput
    })
    activeIndexWorker = worker

    worker.on('message', (progress: IndexProgressPayload) => {
      broadcastToRenderer(IPC_CHANNELS.EVENT_INDEX_PROGRESS, progress)
      if (progress.phase === 'completed') {
        refreshIndexDbConnection()
        const updatedCheck = checkGameAndModVersion(loadAppConfig())
        broadcastToRenderer(IPC_CHANNELS.EVENT_VERSION_CHECK, updatedCheck)
      }
    })

    worker.on('error', (err) => {
      activeIndexWorker = null
      broadcastToRenderer<IndexProgressPayload>(IPC_CHANNELS.EVENT_INDEX_PROGRESS, {
        phase: 'error',
        percent: 0,
        message: `인덱싱 워커 오류: ${err.message}`,
        processedCount: 0,
        totalCount: 0,
        error: err.message
      })
    })

    worker.on('exit', () => {
      activeIndexWorker = null
    })

    return {
      started: true,
      message: '백그라운드 VFS 병합 및 로컬 임베딩 인덱싱을 시작했습니다.'
    }
  })

  ipcMain.handle(IPC_CHANNELS.CANCEL_INDEXING, () => {
    if (activeIndexWorker) {
      activeIndexWorker.postMessage({ type: 'cancel' })
    }
  })

  ipcMain.handle(IPC_CHANNELS.LOAD_LATEST_SAVE, async (): Promise<SaveLoadResult> => {
    const config = loadAppConfig()
    if (!config.documentsDir || !fs.existsSync(config.documentsDir)) {
      return {
        success: false,
        summary: null,
        error: 'CK3 문서 폴더 경로가 유효하지 않습니다. [설정]에서 경로를 확인해 주세요.'
      }
    }

    const latestSavePath = findLatestSaveFile(config.documentsDir)
    if (!latestSavePath) {
      return {
        success: false,
        summary: null,
        error: 'save games 폴더에서 불러올 수 있는 .ck3 세이브 파일을 찾지 못했습니다.'
      }
    }

    return await executeSaveLoadWorker(latestSavePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.LOAD_SAVE_BY_PATH,
    async (_event, savePath: string): Promise<SaveLoadResult> => {
      const validationError = validateSaveFilePath(savePath)
      if (validationError) {
        return {
          success: false,
          summary: null,
          error: validationError
        }
      }
      return await executeSaveLoadWorker(path.resolve(savePath))
    }
  )

  ipcMain.handle(IPC_CHANNELS.GET_CURRENT_SAVE_SUMMARY, () => getCurrentSaveSummary())

  ipcMain.handle(IPC_CHANNELS.LIST_GEMINI_MODELS, async (_event, overrideApiKey?: string) =>
    listAvailableGeminiModels(overrideApiKey)
  )

  ipcMain.handle(
    IPC_CHANNELS.SEND_CHAT_MESSAGE,
    async (_event, payload: ChatRequestPayload) =>
      runAdvisorChatTurn(
        payload,
        (toolStepEvent) => {
          broadcastToRenderer(IPC_CHANNELS.EVENT_AGENT_TOOL_STEP, toolStepEvent)
        },
        (streamChunkEvent) => {
          broadcastToRenderer(IPC_CHANNELS.EVENT_AGENT_STREAM_CHUNK, streamChunkEvent)
        }
      )
  )

  ipcMain.handle(IPC_CHANNELS.CANCEL_CHAT_MESSAGE, (_event, requestId: string) => {
    cancelAdvisorChatTurn(requestId)
  })

  ipcMain.handle(IPC_CHANNELS.LIST_CHAT_SESSIONS, () => listChatSessions())

  ipcMain.handle(IPC_CHANNELS.SAVE_CHAT_SESSION, (_event, session: ChatSession) =>
    saveChatSession(session)
  )

  ipcMain.handle(IPC_CHANNELS.DELETE_CHAT_SESSION, (_event, sessionId: string) =>
    deleteChatSession(sessionId)
  )

  ipcMain.handle(IPC_CHANNELS.SYNTHESIZE_TTS, (_event, payload: TtsSynthesizePayload) =>
    synthesizeAdvisorSpeech(payload)
  )
}
