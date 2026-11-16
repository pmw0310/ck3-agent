import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { Jomini } from 'jomini'
import StreamZip from 'node-stream-zip'
import { env, pipeline } from '@huggingface/transformers'
import * as R from 'remeda'
import { EMBEDDING_DIMENSIONS, INDEX_TARGET_CATEGORIES } from '@shared/constants'
import type { IndexPhase, IndexProgressPayload, VersionSnapshot } from '@shared/types'

export interface IndexWorkerData {
  gameIndexDbPath: string
  modelsCacheDir: string
  steamInstallDir: string
  embeddingModel: string
  versionSnapshot: VersionSnapshot
}

interface VfsFileEntry {
  relPath: string
  sourceMod: string
  diskPath?: string
  zipArchivePath?: string
  zipEntryPath?: string
}

interface LocalizationRecord {
  locKey: string
  textKo: string
  textEn: string
  sourceMod: string
}

interface ParsedScriptEntry {
  category: string
  categoryLabelKo: string
  entryKey: string
  titleKo: string
  descKo: string
  sourceMod: string
  filePath: string
  summaryText: string
  rawScript: string
  parsedJson: string
}

type FeatureExtractorPipeline = (
  texts: string | string[],
  options?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }
) => Promise<{ data: Float32Array }>

const EMBED_BATCH_SIZE = 32
const DB_INSERT_CHUNK_SIZE = 1500
const MAX_RAW_SCRIPT_CHARS = 8000
const MAX_SUMMARY_CHARS = 1200

let isCancelled = false

parentPort?.on('message', (msg: { type?: string }) => {
  if (msg?.type === 'cancel') {
    isCancelled = true
  }
})

const emitProgress = (
  phase: IndexPhase,
  percent: number,
  message: string,
  processedCount = 0,
  totalCount = 0,
  currentItem?: string,
  error?: string
): void => {
  const payload: IndexProgressPayload = {
    phase,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    message,
    processedCount,
    totalCount,
    currentItem,
    error
  }
  parentPort?.postMessage(payload)
}

const initJominiParser = async () => {
  try {
    return await Jomini.initialize()
  } catch {
    const req = createRequire(import.meta.url)
    const jominiEntry = req.resolve('jomini')
    const wasmCandidate = path
      .join(path.dirname(jominiEntry), 'jomini_bg.wasm')
      .replace('app.asar', 'app.asar.unpacked')
    const wasmBytes = fs.readFileSync(wasmCandidate)
    return await Jomini.initialize({ wasm: wasmBytes })
  }
}

const loadSqliteVecSafe = (db: Database.Database): void => {
  try {
    sqliteVec.load(db)
  } catch {
    const extPath = sqliteVec.getLoadablePath().replace('app.asar', 'app.asar.unpacked')
    db.loadExtension(extPath)
  }
}

const walkDiskDirectory = (
  rootDir: string,
  subRelDir: string,
  extFilter: string
): Array<{ relPath: string; diskPath: string }> => {
  const targetDir = path.join(rootDir, subRelDir)
  if (!fs.existsSync(targetDir)) return []

  const results: Array<{ relPath: string; diskPath: string }> = []
  const stack: string[] = [targetDir]

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extFilter)) {
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
        results.push({ relPath, diskPath: fullPath })
      }
    }
  }

  return results
}

const MAX_SINGLE_VFS_FILE_BYTES = 25 * 1024 * 1024

const collectZipModEntries = async (
  zipPath: string,
  targetPrefixes: string[]
): Promise<Array<{ relPath: string; zipEntryPath: string }>> => {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    return R.pipe(
      Object.values(entries),
      R.filter((entry) => !entry.isDirectory && entry.size <= MAX_SINGLE_VFS_FILE_BYTES),
      R.map((entry) => ({
        relPath: entry.name.replace(/\\/g, '/').replace(/^\/+/, ''),
        zipEntryPath: entry.name
      })),
      R.filter(({ relPath }) => {
        if (relPath.includes('..')) return false
        const lower = relPath.toLowerCase()
        const isTxtOrYml = lower.endsWith('.txt') || lower.endsWith('.yml')
        if (!isTxtOrYml) return false
        return targetPrefixes.some((prefix) => lower.startsWith(prefix))
      })
    )
  } finally {
    await zip.close()
  }
}

const buildClausewitzVfs = async (
  steamInstallDir: string,
  snapshot: VersionSnapshot
): Promise<{
  scriptFiles: VfsFileEntry[]
  englishLocFiles: VfsFileEntry[]
  koreanLocFiles: VfsFileEntry[]
}> => {
  const vfsMap = new Map<string, VfsFileEntry>()
  const vanillaGameRoot = path.join(steamInstallDir, 'game')

  const targetScriptDirs = INDEX_TARGET_CATEGORIES.map((c) => c.relDir.toLowerCase())
  const targetLocDirs = ['localization/english', 'localization/korean']
  const allPrefixes = [...targetScriptDirs, ...targetLocDirs].map((p) => `${p}/`)

  // 1. Base Vanilla layer
  for (const cat of INDEX_TARGET_CATEGORIES) {
    const files = walkDiskDirectory(vanillaGameRoot, cat.relDir, '.txt')
    for (const file of files) {
      vfsMap.set(file.relPath.toLowerCase(), {
        relPath: file.relPath,
        sourceMod: 'Vanilla',
        diskPath: file.diskPath
      })
    }
  }

  for (const locDir of targetLocDirs) {
    const files = walkDiskDirectory(vanillaGameRoot, locDir, '.yml')
    for (const file of files) {
      vfsMap.set(file.relPath.toLowerCase(), {
        relPath: file.relPath,
        sourceMod: 'Vanilla',
        diskPath: file.diskPath
      })
    }
  }

  // 2. Active Mod layers in exact dlc_load.json order
  for (const mod of snapshot.enabledMods) {
    if (isCancelled) break
    if (!mod.exists || !mod.resolvedPath) continue

    for (const replaceRel of mod.replacePaths) {
      const normalizedPrefix = `${replaceRel.toLowerCase().replace(/^\/+|\/+$/g, '')}/`
      for (const existingKey of Array.from(vfsMap.keys())) {
        if (existingKey.startsWith(normalizedPrefix)) {
          vfsMap.delete(existingKey)
        }
      }
    }

    if (mod.isArchive && mod.resolvedPath.toLowerCase().endsWith('.zip')) {
      try {
        const zipEntries = await collectZipModEntries(mod.resolvedPath, allPrefixes)
        for (const zEntry of zipEntries) {
          vfsMap.set(zEntry.relPath.toLowerCase(), {
            relPath: zEntry.relPath,
            sourceMod: mod.name,
            zipArchivePath: mod.resolvedPath,
            zipEntryPath: zEntry.zipEntryPath
          })
        }
      } catch {
        // Skip unreadable zip mod
      }
    } else {
      for (const cat of INDEX_TARGET_CATEGORIES) {
        const files = walkDiskDirectory(mod.resolvedPath, cat.relDir, '.txt')
        for (const file of files) {
          vfsMap.set(file.relPath.toLowerCase(), {
            relPath: file.relPath,
            sourceMod: mod.name,
            diskPath: file.diskPath
          })
        }
      }

      for (const locDir of targetLocDirs) {
        const files = walkDiskDirectory(mod.resolvedPath, locDir, '.yml')
        for (const file of files) {
          vfsMap.set(file.relPath.toLowerCase(), {
            relPath: file.relPath,
            sourceMod: mod.name,
            diskPath: file.diskPath
          })
        }
      }
    }
  }

  const allEntries = Array.from(vfsMap.values())

  const scriptFiles = R.pipe(
    allEntries,
    R.filter((entry) => entry.relPath.toLowerCase().startsWith('common/') && entry.relPath.toLowerCase().endsWith('.txt')),
    R.sortBy((entry) => entry.relPath)
  )

  const englishLocFiles = R.pipe(
    allEntries,
    R.filter((entry) => entry.relPath.toLowerCase().startsWith('localization/english/')),
    R.sortBy((entry) => (entry.sourceMod === 'Vanilla' ? 0 : 1))
  )

  const koreanLocFiles = R.pipe(
    allEntries,
    R.filter((entry) => entry.relPath.toLowerCase().startsWith('localization/korean/')),
    R.sortBy((entry) => (entry.sourceMod === 'Vanilla' ? 0 : 1))
  )

  return { scriptFiles, englishLocFiles, koreanLocFiles }
}

const readVfsFileContent = async (
  entry: VfsFileEntry,
  zipCache: Map<string, StreamZip.StreamZipAsync>
): Promise<string> => {
  if (entry.diskPath) {
    const stat = fs.statSync(entry.diskPath)
    if (stat.size > MAX_SINGLE_VFS_FILE_BYTES) return ''
    return fs.readFileSync(entry.diskPath, 'utf8')
  }
  if (entry.zipArchivePath && entry.zipEntryPath) {
    let zip = zipCache.get(entry.zipArchivePath)
    if (!zip) {
      zip = new StreamZip.async({ file: entry.zipArchivePath })
      zipCache.set(entry.zipArchivePath, zip)
    }
    const data = await zip.entryData(entry.zipEntryPath)
    return data.toString('utf8')
  }
  return ''
}

const cleanParadoxFormatting = (rawText: string): string =>
  rawText
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/#[A-Za-z_!;]+(?:\s|$)/g, ' ')
    .replace(/#weak\b|#bold\b|#EMP\b|#high\b|#P\b|#N\b|#V\b|#!/g, '')
    .replace(/\[([^\]|]+)\|[^\]]*\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

const parseLocalizationYmlIntoMap = (
  content: string,
  lang: 'en' | 'ko',
  sourceMod: string,
  locMap: Map<string, LocalizationRecord>
): void => {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('l_')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx <= 0) continue

    const key = trimmed.slice(0, colonIdx).trim()
    if (!key) continue

    const firstQuote = trimmed.indexOf('"', colonIdx + 1)
    const lastQuote = trimmed.lastIndexOf('"')
    if (firstQuote === -1 || lastQuote <= firstQuote) continue

    const rawVal = trimmed.slice(firstQuote + 1, lastQuote)
    const cleaned = cleanParadoxFormatting(rawVal)
    if (!cleaned) continue

    const existing = locMap.get(key)
    if (existing) {
      if (lang === 'ko') {
        existing.textKo = cleaned
        existing.sourceMod = sourceMod
      } else {
        existing.textEn = cleaned
        if (!existing.textKo) existing.sourceMod = sourceMod
      }
    } else {
      locMap.set(key, {
        locKey: key,
        textKo: lang === 'ko' ? cleaned : '',
        textEn: lang === 'en' ? cleaned : '',
        sourceMod
      })
    }
  }
}

const stripCommentsAndResolveAtVars = (rawContent: string): string => {
  const withoutBom = rawContent.replace(/^\uFEFF/, '')
  const lines = withoutBom.split(/\r?\n/)
  const constants = new Map<string, string>()
  const cleanedLines: string[] = []

  for (const line of lines) {
    let inQuotes = false
    let commentPos = -1
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (ch === '"' && line[i - 1] !== '\\') {
        inQuotes = !inQuotes
      } else if (ch === '#' && !inQuotes) {
        commentPos = i
        break
      }
    }

    const uncommented = (commentPos >= 0 ? line.slice(0, commentPos) : line).trimEnd()
    if (!uncommented.trim()) continue

    const constMatch = uncommented.match(/^\s*@([A-Za-z0-9_]+)\s*=\s*([^\s{}#]+)\s*$/)
    if (constMatch) {
      constants.set(constMatch[1], constMatch[2])
      continue
    }

    if (uncommented.trimStart().startsWith('@')) {
      continue
    }

    const replaced = uncommented.replace(/@\[[^\]]+\]|@([A-Za-z0-9_]+)/g, (full, varName?: string) => {
      if (!varName) return '0'
      return constants.get(varName) ?? '0'
    })

    cleanedLines.push(replaced)
  }

  return cleanedLines.join('\n')
}

const extractTopLevelScriptBlocks = (
  cleanedScript: string
): Array<{ key: string; blockText: string }> => {
  const results: Array<{ key: string; blockText: string }> = []
  const len = cleanedScript.length
  let i = 0

  const isWhitespace = (ch: string): boolean =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

  while (i < len) {
    while (i < len && isWhitespace(cleanedScript[i])) i += 1
    if (i >= len) break

    const keyStart = i
    while (
      i < len &&
      !isWhitespace(cleanedScript[i]) &&
      cleanedScript[i] !== '=' &&
      cleanedScript[i] !== '{' &&
      cleanedScript[i] !== '}'
    ) {
      i += 1
    }
    const key = cleanedScript.slice(keyStart, i).trim()
    while (i < len && isWhitespace(cleanedScript[i])) i += 1

    if (!key || cleanedScript[i] !== '=') {
      while (i < len && cleanedScript[i] !== '\n') i += 1
      continue
    }

    i += 1 // skip '='
    while (i < len && isWhitespace(cleanedScript[i])) i += 1

    if (cleanedScript[i] !== '{') {
      while (i < len && cleanedScript[i] !== '\n') i += 1
      continue
    }

    const blockStart = keyStart
    let depth = 0
    let inQuotes = false

    while (i < len) {
      const ch = cleanedScript[i]
      if (ch === '"' && cleanedScript[i - 1] !== '\\') {
        inQuotes = !inQuotes
      } else if (!inQuotes) {
        if (ch === '{') {
          depth += 1
        } else if (ch === '}') {
          depth -= 1
          if (depth === 0) {
            i += 1
            results.push({
              key,
              blockText: cleanedScript.slice(blockStart, i)
            })
            break
          }
        }
      }
      i += 1
    }
  }

  return results
}

const resolveEntryLocalization = (
  entryKey: string,
  parsedObj: Record<string, unknown>,
  locMap: Map<string, LocalizationRecord>
): { titleKo: string; descKo: string } => {
  const customTitleKey = typeof parsedObj.title === 'string' ? parsedObj.title : ''
  const customNameKey = typeof parsedObj.name === 'string' ? parsedObj.name : ''
  const customDescKey = typeof parsedObj.desc === 'string' ? parsedObj.desc : ''

  const titleCandidates = R.pipe(
    [
      customTitleKey,
      customNameKey,
      entryKey,
      `${entryKey}_name`,
      `trait_${entryKey}`,
      `building_${entryKey}`,
      `building_type_${entryKey}`,
      `tradition_${entryKey}_name`,
      `innovation_${entryKey}`,
      `doctrine_${entryKey}_name`,
      `${entryKey}_decision`,
      `${entryKey}_interaction`
    ],
    R.filter((k) => k.length > 0),
    R.unique()
  )

  const descCandidates = R.pipe(
    [
      customDescKey,
      `${entryKey}_desc`,
      `${entryKey}_tooltip`,
      `trait_${entryKey}_desc`,
      `building_${entryKey}_desc`,
      `tradition_${entryKey}_desc`,
      `innovation_${entryKey}_desc`,
      `${entryKey}_effect_tooltip`
    ],
    R.filter((k) => k.length > 0),
    R.unique()
  )

  let titleKo = ''
  for (const cand of titleCandidates) {
    const hit = locMap.get(cand)
    if (hit && (hit.textKo || hit.textEn)) {
      titleKo = hit.textKo || hit.textEn
      break
    }
  }

  let descKo = ''
  for (const cand of descCandidates) {
    const hit = locMap.get(cand)
    if (hit && (hit.textKo || hit.textEn)) {
      descKo = hit.textKo || hit.textEn
      break
    }
  }

  return {
    titleKo: titleKo || entryKey,
    descKo: descKo.slice(0, 400)
  }
}

const buildCompactSummary = (params: {
  categoryLabelKo: string
  entryKey: string
  titleKo: string
  descKo: string
  sourceMod: string
  parsedObj: Record<string, unknown>
}): string => {
  const highlightKeys = [
    'type',
    'group',
    'category',
    'major',
    'cost',
    'minimum_cost',
    'buy_cost',
    'low_maintenance_cost',
    'high_maintenance_cost',
    'damage',
    'toughness',
    'pursuit',
    'screen',
    'siege_value',
    'max',
    'counters',
    'province_modifier',
    'county_modifier',
    'character_modifier',
    'duchy_capital_county_modifier',
    'parameters',
    'layers',
    'can_pick',
    'is_shown',
    'is_valid',
    'is_valid_showing_failures_only',
    'effect'
  ]

  const snippets = R.pipe(
    highlightKeys,
    R.filter((k) => params.parsedObj[k] !== undefined),
    R.map((k) => {
      const serialized = JSON.stringify(params.parsedObj[k])
      return `${k}: ${serialized.slice(0, 180)}`
    })
  )

  const base = [
    `[${params.categoryLabelKo}] ${params.titleKo} (${params.entryKey})`,
    `출처: ${params.sourceMod}`,
    params.descKo ? `설명: ${params.descKo}` : '',
    snippets.length > 0 ? `핵심 속성: ${snippets.join(' | ')}` : ''
  ]
    .filter(Boolean)
    .join(' / ')

  return base.slice(0, MAX_SUMMARY_CHARS)
}

const detectCategoryForPath = (
  relPath: string
): { category: string; labelKo: string } | null => {
  const lower = relPath.toLowerCase()
  const matched = INDEX_TARGET_CATEGORIES.find((cat) =>
    lower.startsWith(`${cat.relDir.toLowerCase()}/`)
  )
  return matched ? { category: matched.category, labelKo: matched.labelKo } : null
}

const runIndexingPipeline = async (): Promise<void> => {
  const data = workerData as IndexWorkerData
  const zipCache = new Map<string, StreamZip.StreamZipAsync>()

  const closeAllZipHandles = async (): Promise<void> => {
    for (const zip of zipCache.values()) {
      await zip.close().catch(() => undefined)
    }
    zipCache.clear()
  }

  try {
    emitProgress('scanning-vfs', 3, 'Clausewitz 가상 파일 시스템 및 활성 모드 병합 스캔 중...')
    const vfs = await buildClausewitzVfs(data.steamInstallDir, data.versionSnapshot)

    if (isCancelled) {
      emitProgress('cancelled', 0, '사용자에 의해 인덱싱이 취소되었습니다.')
      return
    }

    // Step 2: Parse English + Korean Localization
    const locMap = new Map<string, LocalizationRecord>()
    const allLocFiles: Array<{ file: VfsFileEntry; lang: 'en' | 'ko' }> = [
      ...vfs.englishLocFiles.map((file) => ({ file, lang: 'en' as const })),
      ...vfs.koreanLocFiles.map((file) => ({ file, lang: 'ko' as const }))
    ]

    for (let idx = 0; idx < allLocFiles.length; idx += 1) {
      if (isCancelled) {
        emitProgress('cancelled', 0, '인덱싱이 취소되었습니다.')
        return
      }
      const { file, lang } = allLocFiles[idx]
      if (idx % 25 === 0 || idx === allLocFiles.length - 1) {
        const pct = 5 + (idx / Math.max(1, allLocFiles.length)) * 15
        emitProgress(
          'parsing-localization',
          pct,
          `로컬라이제이션 병합 중 · ${lang === 'ko' ? '한국어' : '영어'}...`,
          idx + 1,
          allLocFiles.length,
          `${file.sourceMod}: ${path.basename(file.relPath)}`
        )
      }
      try {
        const content = await readVfsFileContent(file, zipCache)
        if (content) {
          parseLocalizationYmlIntoMap(content, lang, file.sourceMod, locMap)
        }
      } catch {
        // Ignore malformed localization file
      }
    }

    // Step 3: Parse Clausewitz scripts with Jomini
    emitProgress('parsing-scripts', 21, 'Jomini WASM 스크립트 파서 초기화 중...')
    const jomini = await initJominiParser()
    const scriptEntryMap = new Map<string, ParsedScriptEntry>()

    for (let idx = 0; idx < vfs.scriptFiles.length; idx += 1) {
      if (isCancelled) {
        emitProgress('cancelled', 0, '인덱싱이 취소되었습니다.')
        return
      }

      const file = vfs.scriptFiles[idx]
      const catInfo = detectCategoryForPath(file.relPath)
      if (!catInfo) continue

      if (idx % 15 === 0 || idx === vfs.scriptFiles.length - 1) {
        const pct = 22 + (idx / Math.max(1, vfs.scriptFiles.length)) * 26
        emitProgress(
          'parsing-scripts',
          pct,
          `본편 및 모드 스크립트 Jomini 파싱 중 · ${catInfo.labelKo}...`,
          idx + 1,
          vfs.scriptFiles.length,
          `${file.sourceMod}: ${file.relPath}`
        )
      }

      let rawFileContent = ''
      try {
        rawFileContent = await readVfsFileContent(file, zipCache)
      } catch {
        continue
      }
      if (!rawFileContent.trim()) continue

      const cleaned = stripCommentsAndResolveAtVars(rawFileContent)
      const blocks = extractTopLevelScriptBlocks(cleaned)

      for (const block of blocks) {
        if (!block.key || block.key.startsWith('@')) continue
        let parsedObj: Record<string, unknown> = {}
        try {
          const parsedRoot = jomini.parseText(block.blockText) as Record<string, unknown>
          const inner = parsedRoot[block.key]
          parsedObj =
            inner && typeof inner === 'object' && !Array.isArray(inner)
              ? (inner as Record<string, unknown>)
              : { value: inner }
        } catch {
          parsedObj = { unparsedNote: 'complex_macro_block' }
        }

        const { titleKo, descKo } = resolveEntryLocalization(block.key, parsedObj, locMap)
        const summaryText = buildCompactSummary({
          categoryLabelKo: catInfo.labelKo,
          entryKey: block.key,
          titleKo,
          descKo,
          sourceMod: file.sourceMod,
          parsedObj
        })

        const compositeKey = `${catInfo.category}::${block.key}`
        scriptEntryMap.set(compositeKey, {
          category: catInfo.category,
          categoryLabelKo: catInfo.labelKo,
          entryKey: block.key,
          titleKo,
          descKo,
          sourceMod: file.sourceMod,
          filePath: file.relPath,
          summaryText,
          rawScript: block.blockText.slice(0, MAX_RAW_SCRIPT_CHARS),
          parsedJson: JSON.stringify(parsedObj).slice(0, 16000)
        })
      }
    }

    await closeAllZipHandles()

    const allScripts = Array.from(scriptEntryMap.values())

    // Step 4: Local CPU ONNX Embedding via @huggingface/transformers
    emitProgress(
      'loading-embedder',
      50,
      `로컬 CPU 임베딩 모델 준비 중 · ${data.embeddingModel}...`,
      0,
      allScripts.length
    )

    env.cacheDir = data.modelsCacheDir
    env.allowLocalModels = true
    env.allowRemoteModels = true

    const extractor = (await pipeline('feature-extraction', data.embeddingModel, {
      dtype: 'q8',
      progress_callback: (prog: { status?: string; file?: string; progress?: number }) => {
        if (prog.status === 'progress' && typeof prog.progress === 'number') {
          emitProgress(
            'loading-embedder',
            50 + (prog.progress / 100) * 5,
            `임베딩 모델 다운로드 중 · ${prog.file ?? ''} · ${Math.round(prog.progress)}%`,
            Math.round(prog.progress),
            100
          )
        }
      }
    })) as unknown as FeatureExtractorPipeline

    const embeddings: Float32Array[] = []
    const scriptBatches = R.chunk(allScripts, EMBED_BATCH_SIZE)

    for (let bIdx = 0; bIdx < scriptBatches.length; bIdx += 1) {
      if (isCancelled) {
        emitProgress('cancelled', 0, '인덱싱이 취소되었습니다.')
        return
      }

      const batch = scriptBatches[bIdx]
      const batchTexts = batch.map((item) => item.summaryText)
      const output = await extractor(batchTexts, { pooling: 'mean', normalize: true })
      const flatData =
        output.data instanceof Float32Array ? output.data : new Float32Array(output.data)

      for (let i = 0; i < batch.length; i += 1) {
        const start = i * EMBEDDING_DIMENSIONS
        const vecSlice = flatData.slice(start, start + EMBEDDING_DIMENSIONS)
        embeddings.push(vecSlice)
      }

      const processed = Math.min((bIdx + 1) * EMBED_BATCH_SIZE, allScripts.length)
      const pct = 56 + (processed / Math.max(1, allScripts.length)) * 34
      emitProgress(
        'embedding-vectors',
        pct,
        `로컬 ONNX 벡터 임베딩 추론 중 · ${processed.toLocaleString()} / ${allScripts.length.toLocaleString()}...`,
        processed,
        allScripts.length,
        batch[0]?.titleKo
      )
    }

    if (isCancelled) {
      emitProgress('cancelled', 0, '인덱싱이 취소되었습니다.')
      return
    }

    // Step 5: Atomic SQLite + sqlite-vec transaction commit
    emitProgress('committing-db', 92, 'SQLite 및 sqlite-vec 벡터 인덱스 고속 적재 중...')

    const db = new Database(data.gameIndexDbPath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('busy_timeout = 10000')
      loadSqliteVecSafe(db)

      db.exec(`
        CREATE TABLE IF NOT EXISTS meta_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS localization (
          loc_key TEXT PRIMARY KEY,
          text_ko TEXT,
          text_en TEXT,
          source_mod TEXT
        );
        CREATE TABLE IF NOT EXISTS script_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          entry_key TEXT NOT NULL,
          title_ko TEXT,
          desc_ko TEXT,
          source_mod TEXT NOT NULL,
          file_path TEXT NOT NULL,
          summary_text TEXT NOT NULL,
          raw_script TEXT NOT NULL,
          parsed_json TEXT NOT NULL,
          UNIQUE(category, entry_key)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS script_fts USING fts5(
          entry_key,
          category,
          title_ko,
          desc_ko,
          summary_text,
          source_mod
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS script_vec USING vec0(
          embedding float[${EMBEDDING_DIMENSIONS}]
        );
      `)

      const commitAll = db.transaction(() => {
        db.exec('DELETE FROM localization;')
        db.exec('DELETE FROM script_entries;')
        db.exec('DELETE FROM script_fts;')
        db.exec('DELETE FROM script_vec;')

        const insertLocStmt = db.prepare(
          'INSERT OR REPLACE INTO localization (loc_key, text_ko, text_en, source_mod) VALUES (?, ?, ?, ?)'
        )
        const locChunks = R.chunk(Array.from(locMap.values()), DB_INSERT_CHUNK_SIZE)
        for (const chunk of locChunks) {
          for (const loc of chunk) {
            insertLocStmt.run(loc.locKey, loc.textKo, loc.textEn, loc.sourceMod)
          }
        }

        const insertScriptStmt = db.prepare(`
          INSERT INTO script_entries (
            id, category, entry_key, title_ko, desc_ko, source_mod, file_path, summary_text, raw_script, parsed_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        const insertFtsStmt = db.prepare(`
          INSERT INTO script_fts (
            rowid, entry_key, category, title_ko, desc_ko, summary_text, source_mod
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)

        const insertVecStmt = db.prepare(
          'INSERT INTO script_vec (rowid, embedding) VALUES (?, ?)'
        )

        for (let idx = 0; idx < allScripts.length; idx += 1) {
          const rowId = idx + 1
          const item = allScripts[idx]
          const vec = embeddings[idx]

          insertScriptStmt.run(
            rowId,
            item.category,
            item.entryKey,
            item.titleKo,
            item.descKo,
            item.sourceMod,
            item.filePath,
            item.summaryText,
            item.rawScript,
            item.parsedJson
          )

          insertFtsStmt.run(
            rowId,
            item.entryKey,
            item.category,
            item.titleKo,
            item.descKo,
            item.summaryText,
            item.sourceMod
          )

          if (vec && vec.length === EMBEDDING_DIMENSIONS) {
            insertVecStmt.run(BigInt(rowId), Buffer.from(vec.buffer))
          }
        }

        const nowIso = new Date().toISOString()
        db.prepare(
          'INSERT OR REPLACE INTO meta_state (key, value, updated_at) VALUES (?, ?, ?)'
        ).run('version_snapshot', JSON.stringify(data.versionSnapshot), nowIso)
      })

      commitAll()
    } finally {
      db.close()
    }

    emitProgress(
      'completed',
      100,
      `인덱싱 완료! 스크립트 ${allScripts.length.toLocaleString()}건 · 로컬라이제이션 ${locMap.size.toLocaleString()}건 적재됨`,
      allScripts.length,
      allScripts.length
    )
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    emitProgress('error', 0, `인덱싱 중 오류가 발생했습니다: ${errMsg}`, 0, 0, undefined, errMsg)
  } finally {
    await closeAllZipHandles()
  }
}

void runIndexingPipeline()
