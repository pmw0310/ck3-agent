import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import * as R from 'remeda'
import { CK3_STEAM_APP_ID } from '@shared/constants'
import type { DetectedPaths } from '@shared/types'

interface SaveCandidate {
  filePath: string
  fileName: string
  mtimeMs: number
  isReadableTextSave: boolean
}

const normalizeWinPath = (rawPath: string): string =>
  rawPath ? path.normalize(rawPath.replace(/\\\\/g, '\\').trim()) : ''

const directoryExists = (targetPath: string): boolean => {
  if (!targetPath) return false
  try {
    return fs.statSync(targetPath).isDirectory()
  } catch {
    return false
  }
}

const readSteamRegistryPath = (): string[] => {
  if (process.platform !== 'win32') return []

  const regQueries: Array<{ key: string; value: string }> = [
    { key: 'HKCU\\Software\\Valve\\Steam', value: 'SteamPath' },
    { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', value: 'InstallPath' },
    { key: 'HKLM\\SOFTWARE\\Valve\\Steam', value: 'InstallPath' }
  ]

  return R.pipe(
    regQueries,
    R.map(({ key, value }) => {
      try {
        const output = execFileSync('reg.exe', ['query', key, '/v', value], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 2500
        })
        const match = output.match(/REG_SZ\s+(.+)/i)
        return match?.[1] ? normalizeWinPath(match[1]) : ''
      } catch {
        return ''
      }
    }),
    R.filter((item) => item.length > 0 && directoryExists(item)),
    R.unique()
  )
}

const parseLibraryFoldersVdf = (vdfFilePath: string): string[] => {
  try {
    if (!fs.existsSync(vdfFilePath)) return []
    const content = fs.readFileSync(vdfFilePath, 'utf8')
    const matches = Array.from(content.matchAll(/"path"\s+"([^"]+)"/gi))
    return R.pipe(
      matches,
      R.map((match) => normalizeWinPath(match[1] ?? '')),
      R.filter((libPath) => libPath.length > 0 && directoryExists(libPath)),
      R.unique()
    )
  } catch {
    return []
  }
}

const collectSteamLibraries = (): string[] => {
  const fallbackSteamRoots =
    process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'Steam')]
      : process.platform === 'linux'
        ? [
            path.join(os.homedir(), '.local', 'share', 'Steam'),
            path.join(os.homedir(), '.steam', 'steam')
          ]
        : [
            'C:\\Program Files (x86)\\Steam',
            'C:\\Program Files\\Steam',
            'D:\\Steam',
            'D:\\SteamLibrary',
            'E:\\Steam',
            'E:\\SteamLibrary',
            'F:\\SteamLibrary'
          ]

  const seedRoots = R.pipe(
    [...readSteamRegistryPath(), ...fallbackSteamRoots],
    R.map(normalizeWinPath),
    R.filter(directoryExists),
    R.unique()
  )

  const vdfLibraries = R.pipe(
    seedRoots,
    R.flatMap((steamRoot) =>
      parseLibraryFoldersVdf(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'))
    )
  )

  return R.pipe([...seedRoots, ...vdfLibraries], R.filter(directoryExists), R.unique())
}

/**
 * Windows 레지스트리, OneDrive 및 기본 문서 폴더에서 CK3 사용자 문서 경로를 자동 탐색합니다.
 */
export const detectCk3DocumentsDir = (): string => {
  const electronDocs = (() => {
    try {
      return app.getPath('documents')
    } catch {
      return path.join(os.homedir(), 'Documents')
    }
  })()

  const oneDriveDocs = process.env.OneDrive ? path.join(process.env.OneDrive, 'Documents') : ''

  const candidates = R.pipe(
    [electronDocs, path.join(os.homedir(), 'Documents'), oneDriveDocs],
    R.filter((base) => base.length > 0),
    R.map((base) => path.join(base, 'Paradox Interactive', 'Crusader Kings III')),
    R.unique()
  )

  const found = candidates.find(directoryExists)
  return found ?? candidates[0] ?? ''
}

/**
 * Steam 라이브러리 VDF 및 문서 폴더를 스캔하여 CK3 설치·창작마당·세이브·모드 경로를 반환합니다.
 */
export const detectCk3Paths = (): DetectedPaths => {
  const documentsDir = detectCk3DocumentsDir()
  const steamLibraries = collectSteamLibraries()

  const steamInstallCandidates = R.pipe(
    steamLibraries,
    R.map((lib) => path.join(lib, 'steamapps', 'common', 'Crusader Kings III')),
    R.filter((installDir) => directoryExists(path.join(installDir, 'game')) || directoryExists(installDir))
  )

  const workshopCandidates = R.pipe(
    steamLibraries,
    R.map((lib) => path.join(lib, 'steamapps', 'workshop', 'content', CK3_STEAM_APP_ID)),
    R.filter(directoryExists)
  )

  const steamInstallDir = steamInstallCandidates[0] ?? ''
  const workshopDir =
    workshopCandidates[0] ??
    (steamLibraries[0]
      ? path.join(steamLibraries[0], 'steamapps', 'workshop', 'content', CK3_STEAM_APP_ID)
      : '')

  return {
    documentsDir,
    steamInstallDir,
    workshopDir,
    saveGamesDir: documentsDir ? path.join(documentsDir, 'save games') : '',
    modsDir: documentsDir ? path.join(documentsDir, 'mod') : ''
  }
}

/**
 * `.ck3` 세이브 파일 헤더를 검사하여 ZIP 압축 오프셋 및 바이너리 철인 포맷 여부를 판별합니다.
 */
export const inspectSaveFormat = (
  saveFilePath: string
): {
  isBinaryIronman: boolean
  pkOffset: number
  headerFormat: string
} => {
  const fd = fs.openSync(saveFilePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const inspectLen = Math.min(stat.size, 262144)
    const buffer = Buffer.alloc(inspectLen)
    fs.readSync(fd, buffer, 0, inspectLen, 0)

    const magicAscii = buffer.subarray(0, Math.min(24, inspectLen)).toString('utf8')
    let pkOffset = -1
    for (let i = 0; i <= inspectLen - 4; i += 1) {
      if (
        buffer[i] === 0x50 &&
        buffer[i + 1] === 0x4b &&
        buffer[i + 2] === 0x03 &&
        buffer[i + 3] === 0x04
      ) {
        pkOffset = i
        break
      }
    }

    // CK3 SAV0101 / SAV0103 without PK zip and with binary tokens after newline
    const headerPrefix = magicAscii.slice(0, 7)
    const isSavBinaryHeader = headerPrefix === 'SAV0101' || headerPrefix === 'SAV0103'
    const textPreview = buffer.subarray(0, Math.min(256, inspectLen)).toString('utf8')
    const hasPlainMeta = textPreview.includes('meta_data={')

    return {
      isBinaryIronman: isSavBinaryHeader && pkOffset === -1 && !hasPlainMeta,
      pkOffset,
      headerFormat: headerPrefix
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * `save games` 폴더에서 텍스트 `gamestate` 파싱이 가능한 가장 최신 `.ck3` 세이브 경로를 찾습니다.
 */
export const findLatestSaveFile = (documentsDir: string): string | null => {
  const saveGamesDir = path.join(documentsDir, 'save games')
  if (!directoryExists(saveGamesDir)) return null

  const entries = fs.readdirSync(saveGamesDir, { withFileTypes: true })

  const candidates: SaveCandidate[] = R.pipe(
    entries,
    R.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ck3')),
    R.map((entry) => {
      const fullPath = path.join(saveGamesDir, entry.name)
      const stat = fs.statSync(fullPath)
      const format = inspectSaveFormat(fullPath)
      return {
        filePath: fullPath,
        fileName: entry.name,
        mtimeMs: stat.mtimeMs,
        isReadableTextSave: !format.isBinaryIronman
      }
    }),
    R.sortBy([(item) => item.mtimeMs, 'desc'])
  )

  if (candidates.length === 0) return null

  const readableCandidate = candidates.find((item) => item.isReadableTextSave)
  return (readableCandidate ?? candidates[0])?.filePath ?? null
}
