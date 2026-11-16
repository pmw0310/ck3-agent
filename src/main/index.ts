import fs from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { getPortableDataDir, getTempDir } from '@/main/services/configService'
import { closeAllDatabases, initDatabases } from '@/main/services/dbService'
import { registerIpcHandlers, triggerStartupVersionCheck } from '@/main/ipc/handlers'

/**
 * 외부 브라우저로 전달할 URL이 안전한 `http:` / `https:` 프로토콜인지 검증합니다.
 */
const isSafeExternalHttpUrl = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * 이전 비정상 종료 등으로 `./data/tmp`에 남아 있는 임시 세이브 슬라이스 파일을 청소합니다.
 */
const sweepStaleSaveTempFiles = (): void => {
  try {
    const tempDir = getTempDir()
    if (!fs.existsSync(tempDir)) return
    for (const entry of fs.readdirSync(tempDir)) {
      if (entry.startsWith('ck3_save_') && entry.endsWith('.zip')) {
        try {
          fs.unlinkSync(join(tempDir, entry))
        } catch {
          // 파일 잠금 시 무시
        }
      }
    }
  } catch {
    // 임시 폴더 정리 예외 무시
  }
}

const resolveWindowIconPath = (): string | undefined => {
  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(__dirname, '../../build/icon.png'),
    join(process.resourcesPath, 'icon.png')
  ]
  return candidates.find((p) => fs.existsSync(p))
}

const createMainWindow = (): BrowserWindow => {
  const mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101114',
    title: 'CK3 제미나이 에이전트',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalHttpUrl(details.url)) {
      void shell.openExternal(details.url)
    } else {
      console.warn('⚠️ [Security] 허용되지 않은 외부 URL 스킴 차단:', details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const devRendererUrl = process.env.ELECTRON_RENDERER_URL
    if (!app.isPackaged && devRendererUrl && targetUrl.startsWith(devRendererUrl)) {
      return
    }
    event.preventDefault()
    if (isSafeExternalHttpUrl(targetUrl)) {
      void shell.openExternal(targetUrl)
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    triggerStartupVersionCheck()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

void app.whenReady().then(() => {
  getPortableDataDir()
  sweepStaleSaveTempFiles()
  initDatabases()
  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  closeAllDatabases()
})
