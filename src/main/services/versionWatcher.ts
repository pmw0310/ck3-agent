import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import * as R from 'remeda'
import type {
  AppConfig,
  ModDescriptor,
  VersionCheckResult,
  VersionDiffSummary,
  VersionSnapshot
} from '@shared/types'
import { getIndexCounts, getStoredVersionSnapshot } from '@/main/services/dbService'

const SNAPSHOT_MEMO_TTL_MS = 1500
let lastSnapshotMemo: { key: string; expiresAt: number; snapshot: VersionSnapshot } | null = null

interface LauncherSettingsJson {
  version?: string
  rawVersion?: string
}

interface DlcLoadJson {
  enabled_mods?: string[]
  disabled_dlcs?: string[]
}

const parseQuotedField = (content: string, key: string): string => {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm')
  const match = content.match(regex)
  return match?.[1]?.trim() ?? ''
}

const parseReplacePaths = (content: string): string[] => {
  const matches = Array.from(content.matchAll(/^\s*replace_path\s*=\s*"([^"]+)"/gm))
  return R.pipe(
    matches,
    R.map((match) => (match[1] ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')),
    R.filter((p) => p.length > 0),
    R.unique()
  )
}

const computeDirectorySampleMtime = (targetPath: string, isArchive: boolean): number => {
  try {
    const rootStat = fs.statSync(targetPath)
    if (isArchive || !rootStat.isDirectory()) {
      return Math.round(rootStat.mtimeMs)
    }

    const descriptorPath = path.join(targetPath, 'descriptor.mod')
    const descriptorMtime = fs.existsSync(descriptorPath)
      ? fs.statSync(descriptorPath).mtimeMs
      : 0

    const subDirs = ['common', 'localization', 'events']
    const subMtimes = R.pipe(
      subDirs,
      R.map((sub) => {
        const subPath = path.join(targetPath, sub)
        try {
          return fs.existsSync(subPath) ? fs.statSync(subPath).mtimeMs : 0
        } catch {
          return 0
        }
      })
    )

    return Math.round(Math.max(rootStat.mtimeMs, descriptorMtime, ...subMtimes))
  } catch {
    return 0
  }
}

/**
 * 개별 `.mod` 디스크립터 파일을 파싱하여 실제 디스크/ZIP 경로, `replace_path`, 최신 수정 시각을 계산합니다.
 */
export const parseModDescriptorFile = (
  modFileRelPath: string,
  documentsDir: string,
  workshopDir: string
): ModDescriptor => {
  const safeRel = modFileRelPath.replace(/\\/g, '/')
  const normalizedDocs = path.resolve(documentsDir || '.')
  const descriptorFullPath = path.resolve(normalizedDocs, safeRel)
  const isInsideDocuments =
    descriptorFullPath.startsWith(`${normalizedDocs}${path.sep}`) ||
    descriptorFullPath === normalizedDocs

  if (!isInsideDocuments || safeRel.includes('..') || !fs.existsSync(descriptorFullPath)) {
    return {
      modFileRelPath: safeRel,
      name: path.basename(safeRel, '.mod'),
      version: 'unknown',
      supportedVersion: '',
      resolvedPath: '',
      isArchive: false,
      remoteFileId: '',
      replacePaths: [],
      mtimeMs: 0,
      exists: false
    }
  }

  const content = fs.readFileSync(descriptorFullPath, 'utf8')
  const name = parseQuotedField(content, 'name') || path.basename(modFileRelPath, '.mod')
  const version = parseQuotedField(content, 'version') || '1.0'
  const supportedVersion = parseQuotedField(content, 'supported_version')
  const rawModPath = parseQuotedField(content, 'path')
  const rawArchivePath = parseQuotedField(content, 'archive')
  const remoteFileId = parseQuotedField(content, 'remote_file_id')
  const replacePaths = parseReplacePaths(content)

  const targetRaw = rawArchivePath || rawModPath
  const isArchive = Boolean(rawArchivePath) || targetRaw.toLowerCase().endsWith('.zip')

  const resolveCandidatePath = (): string => {
    const candidates: string[] = []
    if (targetRaw) {
      if (path.isAbsolute(targetRaw)) {
        candidates.push(path.normalize(targetRaw))
      } else {
        candidates.push(path.join(documentsDir, targetRaw))
      }
    }
    if (remoteFileId && workshopDir) {
      candidates.push(path.join(workshopDir, remoteFileId))
    }
    const existing = candidates.find((candidate) => fs.existsSync(candidate))
    return existing ?? candidates[0] ?? ''
  }

  const resolvedPath = resolveCandidatePath()
  const exists = Boolean(resolvedPath && fs.existsSync(resolvedPath))
  const descriptorStatMtime = Math.round(fs.statSync(descriptorFullPath).mtimeMs)
  const contentMtime = exists ? computeDirectorySampleMtime(resolvedPath, isArchive) : 0

  return {
    modFileRelPath: modFileRelPath.replace(/\\/g, '/'),
    name,
    version,
    supportedVersion,
    resolvedPath,
    isArchive,
    remoteFileId,
    replacePaths,
    mtimeMs: Math.max(descriptorStatMtime, contentMtime),
    exists
  }
}

const readBaseGameVersion = (
  steamInstallDir: string
): { baseGameVersion: string; rawGameVersion: string } => {
  const launcherSettingsPath = path.join(steamInstallDir, 'launcher', 'launcher-settings.json')
  try {
    if (fs.existsSync(launcherSettingsPath)) {
      const parsed = JSON.parse(
        fs.readFileSync(launcherSettingsPath, 'utf8')
      ) as LauncherSettingsJson
      return {
        baseGameVersion: parsed.version || parsed.rawVersion || 'Unknown',
        rawGameVersion: parsed.rawVersion || parsed.version || 'Unknown'
      }
    }
  } catch {
    // Fallback below
  }

  const exePath = path.join(steamInstallDir, 'binaries', 'ck3.exe')
  if (fs.existsSync(exePath)) {
    const stat = fs.statSync(exePath)
    const fallbackVer = `exe-${Math.round(stat.mtimeMs)}`
    return { baseGameVersion: fallbackVer, rawGameVersion: fallbackVer }
  }

  return { baseGameVersion: '미감지', rawGameVersion: 'missing' }
}

const readActivePlaysetName = (documentsDir: string): string => {
  const launcherDbPath = path.join(documentsDir, 'launcher-v2.sqlite')
  if (!fs.existsSync(launcherDbPath)) {
    return '기본 플레이세트'
  }

  let db: Database.Database | null = null
  try {
    db = new Database(launcherDbPath, { readonly: true, fileMustExist: true })
    const row = db
      .prepare('SELECT name FROM playsets WHERE isActive = 1 LIMIT 1')
      .get() as { name?: string } | undefined
    return row?.name || '기본 플레이세트'
  } catch {
    return '기본 플레이세트'
  } finally {
    try {
      db?.close()
    } catch {
      // Ignore close error
    }
  }
}

/**
 * 현재 게임 본편 버전, 활성 플레이세트 및 `dlc_load.json` 활성 모드 순서의 SHA-256 지문 스냅샷을 생성합니다.
 */
export const captureCurrentVersionSnapshot = (config: AppConfig): VersionSnapshot => {
  const memoKey = `${config.steamInstallDir}|${config.documentsDir}|${config.workshopDir}`
  const now = Date.now()
  if (lastSnapshotMemo && lastSnapshotMemo.key === memoKey && lastSnapshotMemo.expiresAt > now) {
    return lastSnapshotMemo.snapshot
  }
  const { baseGameVersion, rawGameVersion } = readBaseGameVersion(config.steamInstallDir)
  const activePlaysetName = readActivePlaysetName(config.documentsDir)

  const dlcLoadPath = path.join(config.documentsDir, 'dlc_load.json')
  let enabledModRelPaths: string[] = []
  try {
    if (fs.existsSync(dlcLoadPath)) {
      const parsed = JSON.parse(fs.readFileSync(dlcLoadPath, 'utf8')) as DlcLoadJson
      enabledModRelPaths = Array.isArray(parsed.enabled_mods) ? parsed.enabled_mods : []
    }
  } catch {
    enabledModRelPaths = []
  }

  const enabledMods = R.pipe(
    enabledModRelPaths,
    R.map((relPath) => parseModDescriptorFile(relPath, config.documentsDir, config.workshopDir))
  )

  const hashPayload = JSON.stringify({
    rawGameVersion,
    activePlaysetName,
    mods: R.pipe(
      enabledMods,
      R.map((mod) => ({
        rel: mod.modFileRelPath,
        version: mod.version,
        resolvedPath: mod.resolvedPath,
        mtimeMs: mod.mtimeMs,
        replacePaths: mod.replacePaths,
        exists: mod.exists
      }))
    )
  })

  const fingerprintHash = crypto.createHash('sha256').update(hashPayload).digest('hex').slice(0, 16)

  const snapshot: VersionSnapshot = {
    fingerprintHash,
    baseGameVersion,
    rawGameVersion,
    activePlaysetName,
    enabledMods,
    capturedAt: new Date().toISOString()
  }
  lastSnapshotMemo = {
    key: memoKey,
    expiresAt: now + SNAPSHOT_MEMO_TTL_MS,
    snapshot
  }
  return snapshot
}

const buildDiffSummary = (
  current: VersionSnapshot,
  stored: VersionSnapshot | null
): VersionDiffSummary => {
  if (!stored) {
    return {
      isFirstIndex: true,
      baseVersionChanged: false,
      previousBaseVersion: null,
      currentBaseVersion: current.baseGameVersion,
      playsetChanged: false,
      previousPlaysetName: null,
      currentPlaysetName: current.activePlaysetName,
      addedMods: R.pipe(current.enabledMods, R.map((m) => m.name)),
      removedMods: [],
      updatedMods: [],
      orderChanged: false
    }
  }

  const prevMap = new Map(stored.enabledMods.map((m) => [m.modFileRelPath, m]))
  const currMap = new Map(current.enabledMods.map((m) => [m.modFileRelPath, m]))

  const addedMods = R.pipe(
    current.enabledMods,
    R.filter((m) => !prevMap.has(m.modFileRelPath)),
    R.map((m) => `${m.name} · v${m.version}`)
  )

  const removedMods = R.pipe(
    stored.enabledMods,
    R.filter((m) => !currMap.has(m.modFileRelPath)),
    R.map((m) => m.name)
  )

  const updatedMods = R.pipe(
    current.enabledMods,
    R.filter((m) => {
      const prev = prevMap.get(m.modFileRelPath)
      if (!prev) return false
      return prev.version !== m.version || prev.mtimeMs !== m.mtimeMs
    }),
    R.map((m) => {
      const prev = prevMap.get(m.modFileRelPath)!
      return prev.version !== m.version
        ? `${m.name} · v${prev.version} → v${m.version}`
        : `${m.name} · 파일 갱신 감지`
    })
  )

  const commonCurrentOrder = R.pipe(
    current.enabledMods,
    R.filter((m) => prevMap.has(m.modFileRelPath)),
    R.map((m) => m.modFileRelPath)
  )

  const commonStoredOrder = R.pipe(
    stored.enabledMods,
    R.filter((m) => currMap.has(m.modFileRelPath)),
    R.map((m) => m.modFileRelPath)
  )

  const orderChanged =
    commonCurrentOrder.length === commonStoredOrder.length &&
    commonCurrentOrder.some((rel, idx) => rel !== commonStoredOrder[idx])

  return {
    isFirstIndex: false,
    baseVersionChanged: stored.rawGameVersion !== current.rawGameVersion,
    previousBaseVersion: stored.baseGameVersion,
    currentBaseVersion: current.baseGameVersion,
    playsetChanged: stored.activePlaysetName !== current.activePlaysetName,
    previousPlaysetName: stored.activePlaysetName,
    currentPlaysetName: current.activePlaysetName,
    addedMods,
    removedMods,
    updatedMods,
    orderChanged
  }
}

const formatReasonSummary = (diff: VersionDiffSummary, indexedScriptCount: number): string => {
  if (diff.isFirstIndex || indexedScriptCount === 0) {
    return `초기 스크립트·모드 인덱스가 아직 생성되지 않았습니다 · 활성 모드 ${diff.addedMods.length}개`
  }

  const reasons: string[] = []
  if (diff.baseVersionChanged) {
    reasons.push(`게임 본편 업데이트 ${diff.previousBaseVersion} → ${diff.currentBaseVersion}`)
  }
  if (diff.playsetChanged) {
    reasons.push(`플레이세트 전환 ${diff.previousPlaysetName} → ${diff.currentPlaysetName}`)
  }
  if (diff.addedMods.length > 0) {
    reasons.push(`추가된 모드 ${diff.addedMods.length}개`)
  }
  if (diff.removedMods.length > 0) {
    reasons.push(`제거된 모드 ${diff.removedMods.length}개`)
  }
  if (diff.updatedMods.length > 0) {
    reasons.push(`업데이트·수정된 모드 ${diff.updatedMods.length}개`)
  }
  if (diff.orderChanged) {
    reasons.push('모드 로드 순서 변경')
  }

  return reasons.length > 0
    ? reasons.join(' · ')
    : '해시 불일치가 감지되어 인덱스 동기화가 필요합니다.'
}

/**
 * 저장된 인덱스 스냅샷과 현재 게임·모드 상태를 비교하여 재인덱싱 필요 여부를 판정합니다.
 */
export const checkGameAndModVersion = (config: AppConfig): VersionCheckResult => {
  const missingPaths: string[] = []
  const gameDir = config.steamInstallDir ? path.join(config.steamInstallDir, 'game') : ''

  if (!config.steamInstallDir || !fs.existsSync(gameDir)) {
    missingPaths.push('CK3 게임 설치 폴더')
  }
  if (!config.documentsDir || !fs.existsSync(config.documentsDir)) {
    missingPaths.push('CK3 문서 폴더')
  }

  const currentSnapshot = captureCurrentVersionSnapshot(config)
  const storedSnapshot = getStoredVersionSnapshot()
  const { scriptCount, locCount } = getIndexCounts()
  const diff = buildDiffSummary(currentSnapshot, storedSnapshot)

  const needsReindex =
    !storedSnapshot ||
    scriptCount === 0 ||
    storedSnapshot.fingerprintHash !== currentSnapshot.fingerprintHash

  const reasonSummary =
    missingPaths.length > 0
      ? `필수 경로를 찾을 수 없습니다: ${missingPaths.join(', ')}`
      : needsReindex
        ? formatReasonSummary(diff, scriptCount)
        : '본편 및 활성 모드 인덱스가 최신 상태입니다.'

  return {
    needsReindex,
    reasonSummary,
    currentSnapshot,
    storedSnapshot,
    diff,
    indexedScriptCount: scriptCount,
    indexedLocCount: locCount,
    pathsValid: missingPaths.length === 0,
    missingPaths
  }
}
