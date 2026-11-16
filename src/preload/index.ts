import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants'
import type {
  AgentStreamChunkEvent,
  AgentToolStepEvent,
  ChatRequestPayload,
  ChatSession,
  Ck3Api,
  IndexProgressPayload,
  SaveProgressPayload,
  TtsSynthesizePayload,
  UpdateSettingsPayload,
  VersionCheckResult
} from '@shared/types'

const ck3Api: Ck3Api = {
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),
  updateSettings: (payload: UpdateSettingsPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTINGS, payload),
  autoDetectPaths: () => ipcRenderer.invoke(IPC_CHANNELS.AUTO_DETECT_PATHS),
  selectDirectory: (title: string, defaultPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_DIRECTORY, title, defaultPath),
  selectSaveFile: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_SAVE_FILE, defaultPath),
  checkVersion: () => ipcRenderer.invoke(IPC_CHANNELS.CHECK_VERSION),
  startIndexing: (force?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.START_INDEXING, force),
  cancelIndexing: () => ipcRenderer.invoke(IPC_CHANNELS.CANCEL_INDEXING),
  loadLatestSave: () => ipcRenderer.invoke(IPC_CHANNELS.LOAD_LATEST_SAVE),
  loadSaveByPath: (savePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOAD_SAVE_BY_PATH, savePath),
  getCurrentSaveSummary: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CURRENT_SAVE_SUMMARY),
  listGeminiModels: (overrideApiKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_GEMINI_MODELS, overrideApiKey),
  sendChatMessage: (payload: ChatRequestPayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEND_CHAT_MESSAGE, payload),
  cancelChatMessage: (requestId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_CHAT_MESSAGE, requestId),
  listChatSessions: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_CHAT_SESSIONS),
  saveChatSession: (session: ChatSession) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_CHAT_SESSION, session),
  deleteChatSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_CHAT_SESSION, sessionId),
  synthesizeTts: (payload: TtsSynthesizePayload) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNTHESIZE_TTS, payload),

  onIndexProgress: (callback: (payload: IndexProgressPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: IndexProgressPayload): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.EVENT_INDEX_PROGRESS, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_INDEX_PROGRESS, listener)
    }
  },

  onSaveProgress: (callback: (payload: SaveProgressPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SaveProgressPayload): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.EVENT_SAVE_PROGRESS, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_SAVE_PROGRESS, listener)
    }
  },

  onVersionCheckResult: (callback: (result: VersionCheckResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: VersionCheckResult): void => {
      callback(result)
    }
    ipcRenderer.on(IPC_CHANNELS.EVENT_VERSION_CHECK, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_VERSION_CHECK, listener)
    }
  },

  onAgentToolStep: (callback: (event: AgentToolStepEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentToolStepEvent): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.EVENT_AGENT_TOOL_STEP, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_AGENT_TOOL_STEP, listener)
    }
  },

  onAgentStreamChunk: (callback: (event: AgentStreamChunkEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentStreamChunkEvent): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.EVENT_AGENT_STREAM_CHUNK, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_AGENT_STREAM_CHUNK, listener)
    }
  }
}

contextBridge.exposeInMainWorld('ck3Api', ck3Api)
