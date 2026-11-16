import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { Jomini } from 'jomini'
import StreamZip from 'node-stream-zip'
import * as R from 'remeda'
import type { SaveParsePhase, SaveProgressPayload, SaveSummary } from '@shared/types'

export interface SaveWorkerData {
  saveFilePath: string
  saveStateDbPath: string
  gameIndexDbPath: string
  tempDir: string
}

interface StrippedTitleBlock {
  numericId: number
  rawBlock: string
}

interface ParsedTitleInfo {
  numericId: number
  key: string
  customName: string
  holderId: number
  deFactoLiegeNumId: number
  deJureLiegeNumId: number
  capitalProvinceId: number
  heirIds: number[]
  laws: string[]
}

interface ProvinceHoldingInfo {
  holdingType: string
  buildings: string[]
  income: number
  levy: number
}

interface CountyMetaInfo {
  development: number
  control: number
  cultureId: number
  riteId: number
}

const JOMINI_CHUNK_SIZE = 250

const emitProgress = (
  phase: SaveParsePhase,
  percent: number,
  message: string,
  processedCount = 0,
  totalCount = 0,
  error?: string
): void => {
  const payload: SaveProgressPayload = {
    phase,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    message,
    processedCount,
    totalCount,
    error
  }
  parentPort?.postMessage({ type: 'progress', payload })
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

const inspectHeader = (
  filePath: string
): { isBinaryIronman: boolean; pkOffset: number } => {
  const fd = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const inspectLen = Math.min(stat.size, 262144)
    const buffer = Buffer.alloc(inspectLen)
    fs.readSync(fd, buffer, 0, inspectLen, 0)

    const pkSig = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    const pkOffset = buffer.indexOf(pkSig)
    const magic = buffer.subarray(0, 7).toString('utf8')
    const preview = buffer.subarray(0, Math.min(300, inspectLen)).toString('utf8')
    const isBinaryIronman =
      (magic === 'SAV0101' || magic === 'SAV0103') &&
      pkOffset === -1 &&
      !preview.includes('meta_data={')

    return { isBinaryIronman, pkOffset }
  } finally {
    fs.closeSync(fd)
  }
}

const extractNumericCurrency = (val: unknown): number => {
  if (typeof val === 'number') return Number(val.toFixed(2))
  if (typeof val === 'string') {
    const num = Number(val)
    return Number.isFinite(num) ? Number(num.toFixed(2)) : 0
  }
  if (val && typeof val === 'object') {
    const rec = val as Record<string, unknown>
    if (typeof rec.currency === 'number') return Number(rec.currency.toFixed(2))
    if (typeof rec.value === 'number') return Number(rec.value.toFixed(2))
    if (typeof rec.accumulated === 'number' && rec.currency === undefined) {
      return Number(rec.accumulated.toFixed(2))
    }
  }
  return 0
}

const toNumberArray = (val: unknown): number[] => {
  if (Array.isArray(val)) {
    return R.pipe(
      val,
      R.map((v) => Number(v)),
      R.filter((n) => Number.isFinite(n))
    )
  }
  if (typeof val === 'number' && Number.isFinite(val)) return [val]
  return []
}

const toStringArray = (val: unknown): string[] => {
  if (Array.isArray(val)) {
    return R.pipe(
      val,
      R.map((v) => String(v)),
      R.filter((s) => s.length > 0)
    )
  }
  if (typeof val === 'string' && val.length > 0) return [val]
  return []
}

const formatParadoxDate = (val: unknown): string => {
  if (!val) return ''
  if (val instanceof Date) {
    const y = val.getUTCFullYear()
    const m = val.getUTCMonth() + 1
    const d = val.getUTCDate()
    return `${y}.${m}.${d}`
  }
  return String(val)
}

const calculateAge = (birthStr: string, currentDateStr: string): number => {
  const bYear = Number(birthStr.split('.')[0])
  const cYear = Number(currentDateStr.split('.')[0])
  if (!Number.isFinite(bYear) || !Number.isFinite(cYear)) return 0
  return Math.max(0, cYear - bYear)
}

const inferTitleTier = (titleKey: string): string => {
  if (titleKey.startsWith('e_')) return 'empire'
  if (titleKey.startsWith('k_')) return 'kingdom'
  if (titleKey.startsWith('d_')) return 'duchy'
  if (titleKey.startsWith('c_')) return 'county'
  if (titleKey.startsWith('b_')) return 'barony'
  return 'other'
}

interface LazyLocResolver {
  localize: (key: string, fallback?: string) => string
  close: () => void
}

const openLazyLocResolver = (gameIndexDbPath: string): LazyLocResolver => {
  if (!fs.existsSync(gameIndexDbPath)) {
    return {
      localize: (key: string, fallback?: string) => fallback || key,
      close: () => undefined
    }
  }

  let indexDb: Database.Database | null = null
  let selectStmt: Database.Statement<[string, string, string, string]> | null = null
  const memo = new Map<string, string>()

  try {
    indexDb = new Database(gameIndexDbPath, { readonly: true, fileMustExist: true })
    indexDb.pragma('busy_timeout = 5000')
    selectStmt = indexDb.prepare(
      `SELECT loc_key, text_ko, text_en
       FROM localization
       WHERE loc_key IN (?, ?, ?, ?)`
    )
  } catch {
    try {
      indexDb?.close()
    } catch {
      // Ignore
    }
    return {
      localize: (key: string, fallback?: string) => fallback || key,
      close: () => undefined
    }
  }

  return {
    localize: (key: string, fallback?: string): string => {
      if (!key) return fallback || ''
      const hit = memo.get(key)
      if (hit !== undefined) {
        return hit || fallback || key
      }

      if (!selectStmt) {
        return fallback || key
      }

      const c1 = key
      const c2 = `trait_${key}`
      const c3 = `building_${key}`
      const c4 = `${key}_name`

      try {
        const rows = selectStmt.all(c1, c2, c3, c4) as Array<{
          loc_key: string
          text_ko: string | null
          text_en: string | null
        }>
        const byKey = new Map<string, string>()
        for (const r of rows) {
          const val = r.text_ko || r.text_en
          if (val) byKey.set(r.loc_key, val)
        }
        const resolved =
          byKey.get(c1) || byKey.get(c2) || byKey.get(c3) || byKey.get(c4) || ''
        memo.set(key, resolved)
        return resolved || fallback || key
      } catch {
        return fallback || key
      }
    },
    close: (): void => {
      memo.clear()
      try {
        indexDb?.close()
      } catch {
        // Ignore
      }
      indexDb = null
      selectStmt = null
    }
  }
}

const stripHeavySubblocksFromCharacter = (lines: string[]): string => {
  const out: string[] = []
  let skipDepth = 0

  for (const line of lines) {
    const trimmed = line.trimStart()

    if (skipDepth > 0) {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '{') skipDepth += 1
        else if (line[i] === '}') skipDepth -= 1
      }
      if (skipDepth < 0) skipDepth = 0
      continue
    }

    if (
      trimmed.startsWith('dna=') ||
      trimmed.startsWith('memories=') ||
      trimmed.startsWith('trait_xp_amounts=')
    ) {
      continue
    }

    if (
      trimmed.startsWith('variables={') ||
      trimmed.startsWith('portrait_override={') ||
      trimmed.startsWith('court_amenities={')
    ) {
      skipDepth = 0
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '{') skipDepth += 1
        else if (line[i] === '}') skipDepth -= 1
      }
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}

const stripHistoryFromTitleBlock = (lines: string[]): string => {
  const out: string[] = []
  let skipDepth = 0

  for (const line of lines) {
    const trimmed = line.trimStart()
    if (skipDepth > 0) {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '{') skipDepth += 1
        else if (line[i] === '}') skipDepth -= 1
      }
      if (skipDepth < 0) skipDepth = 0
      continue
    }

    if (
      trimmed.startsWith('history={') ||
      trimmed.startsWith('variables={') ||
      trimmed.startsWith('claim={')
    ) {
      skipDepth = 0
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '{') skipDepth += 1
        else if (line[i] === '}') skipDepth -= 1
      }
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}

const runSaveParsePipeline = async (): Promise<void> => {
  const data = workerData as SaveWorkerData
  let tempZipPath = ''
  let zipHandle: StreamZip.StreamZipAsync | null = null
  let locResolver: LazyLocResolver | null = null

  try {
    if (!fs.existsSync(data.saveFilePath)) {
      throw new Error(`세이브 파일을 찾을 수 없습니다: ${data.saveFilePath}`)
    }

    emitProgress('extracting', 4, '세이브 파일 포맷 검사 및 스트림 준비 중...')
    const header = inspectHeader(data.saveFilePath)

    if (header.isBinaryIronman) {
      throw new Error(
        '선택한 세이브 파일은 바이너리 철인 토큰으로 인코딩되어 있습니다. 일반 저장 .ck3 파일이나 비철인 수동 저장 파일을 불러와 주세요.'
      )
    }

    let gamestateStream: NodeJS.ReadableStream

    if (header.pkOffset >= 0) {
      let targetZipFile = data.saveFilePath
      if (header.pkOffset > 0) {
        tempZipPath = path.join(data.tempDir, `ck3_save_${crypto.randomUUID()}.zip`)
        await streamPipeline(
          fs.createReadStream(data.saveFilePath, { start: header.pkOffset }),
          fs.createWriteStream(tempZipPath)
        )
        targetZipFile = tempZipPath
      }

      zipHandle = new StreamZip.async({ file: targetZipFile })
      gamestateStream = await zipHandle.stream('gamestate')
    } else {
      gamestateStream = fs.createReadStream(data.saveFilePath)
    }

    emitProgress('scanning-sections', 12, 'gamestate 핵심 섹션 고속 스트리밍 추출 중...')

    const directSections = new Set([
      'meta_data',
      'currently_played_characters',
      'played_character',
      'traits_lookup',
      'rites',
      'wars',
      'faction_manager',
      'county_manager'
    ])

    const capturedSections = new Map<string, string[]>()
    const livingRawBlocks = new Map<number, string>()
    const landedCharacterIds = new Set<number>()
    const titleStrippedBlocks: StrippedTitleBlock[] = []
    const provinceBlocks: Array<{ id: number; raw: string }> = []
    const houseBlocks = new Map<number, string>()
    const dynastyBlocks = new Map<number, string>()
    const faithBlocks = new Map<number, string>()
    const cultureBlocks = new Map<number, string>()
    const regimentBlocks = new Map<number, string>()
    const schemeBlocks: string[] = []

    let activeTopSection = ''
    let subMode:
      | 'none'
      | 'living_item'
      | 'titles_inner'
      | 'title_item'
      | 'provinces_item'
      | 'house_inner'
      | 'house_item'
      | 'dynasties_inner'
      | 'dynasty_item'
      | 'faith_item'
      | 'culture_inner'
      | 'culture_item'
      | 'regiments_inner'
      | 'regiment_item'
      | 'schemes_active'
      | 'scheme_item' = 'none'

    let currentSubId = -1
    let currentSubLines: string[] = []
    let subBraceDepth = 0
    let lineCount = 0
    let remainder = ''

    const countBraces = (line: string): number => {
      let delta = 0
      let inQuotes = false
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]
        if (ch === '"' && line[i - 1] !== '\\') inQuotes = !inQuotes
        else if (!inQuotes) {
          if (ch === '{') delta += 1
          else if (ch === '}') delta -= 1
        }
      }
      return delta
    }

    for await (const rawChunk of gamestateStream) {
      const chunkStr = remainder + Buffer.from(rawChunk).toString('utf8')
      const lines = chunkStr.split('\n')
      remainder = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        lineCount += 1

        if (lineCount % 450000 === 0) {
          const scanPct = Math.min(52, 12 + Math.floor(lineCount / 160000))
          emitProgress(
            'scanning-sections',
            scanPct,
            `gamestate 스트림 스캔 중 · ${(lineCount / 1000000).toFixed(1)}M 라인 처리...`,
            lineCount,
            6000000
          )
        }

        // Detect new top-level section at column 0 (`section_name=...`)
        if (
          line.length > 0 &&
          line[0] >= 'a' &&
          line[0] <= 'z' &&
          line.includes('=') &&
          subBraceDepth <= 0
        ) {
          const eqIdx = line.indexOf('=')
          const keyName = line.slice(0, eqIdx)
          activeTopSection = keyName
          subMode = 'none'
          currentSubLines = []
          subBraceDepth = 0

          if (directSections.has(keyName)) {
            capturedSections.set(keyName, [line])
            if (!line.endsWith('{') && line.includes('}')) {
              activeTopSection = ''
            }
          }
          continue
        }

        if (!activeTopSection) continue

        // Direct small/medium section collection
        if (directSections.has(activeTopSection)) {
          const arr = capturedSections.get(activeTopSection)
          arr?.push(line)
          if (line === '}') {
            activeTopSection = ''
          }
          continue
        }

        // Specialized streaming collectors for massive sections
        if (activeTopSection === 'living') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            const m = line.match(/^(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [line]
              subBraceDepth = 1
              subMode = 'living_item'
            }
          } else if (subMode === 'living_item') {
            currentSubLines.push(line)
            subBraceDepth += countBraces(line)
            if (line.includes('landed_data={') || line.includes('playable_data={')) {
              landedCharacterIds.add(currentSubId)
            }
            if (subBraceDepth <= 0) {
              const stripped = stripHeavySubblocksFromCharacter(currentSubLines)
              livingRawBlocks.set(currentSubId, stripped)
              subMode = 'none'
              subBraceDepth = 0
            }
          }
          continue
        }

        if (activeTopSection === 'landed_titles') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            if (line === '\tlanded_titles={') {
              subMode = 'titles_inner'
            }
          } else if (subMode === 'titles_inner') {
            if (line === '\t}') {
              subMode = 'none'
              continue
            }
            const m = line.match(/^(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [line]
              subBraceDepth = 1
              subMode = 'title_item'
            }
          } else if (subMode === 'title_item') {
            currentSubLines.push(line)
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              const stripped = stripHistoryFromTitleBlock(currentSubLines)
              if (stripped.includes('holder=') || stripped.includes('key=c_')) {
                titleStrippedBlocks.push({ numericId: currentSubId, rawBlock: stripped })
              }
              subMode = 'titles_inner'
              subBraceDepth = 0
            }
          }
          continue
        }

        if (activeTopSection === 'provinces') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            const m = line.match(/^\t(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [`${currentSubId}={`]
              subBraceDepth = 1
              subMode = 'provinces_item'
            }
          } else if (subMode === 'provinces_item') {
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              currentSubLines.push('}')
              const joined = currentSubLines.join('\n')
              if (joined.includes('type=')) {
                provinceBlocks.push({ id: currentSubId, raw: joined })
              }
              subMode = 'none'
              subBraceDepth = 0
            } else {
              currentSubLines.push(line)
            }
          }
          continue
        }

        if (activeTopSection === 'dynasties') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            if (line === '\tdynasty_house={') subMode = 'house_inner'
            else if (line === '\tdynasties={') subMode = 'dynasties_inner'
          } else if (subMode === 'house_inner') {
            if (line === '\t}') {
              subMode = 'none'
              continue
            }
            const m = line.match(/^(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [line]
              subBraceDepth = 1
              subMode = 'house_item'
            }
          } else if (subMode === 'house_item') {
            currentSubLines.push(line)
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              houseBlocks.set(currentSubId, stripHistoryFromTitleBlock(currentSubLines))
              subMode = 'house_inner'
              subBraceDepth = 0
            }
          } else if (subMode === 'dynasties_inner') {
            if (line === '\t}') {
              subMode = 'none'
              continue
            }
            const m = line.match(/^(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [line]
              subBraceDepth = 1
              subMode = 'dynasty_item'
            }
          } else if (subMode === 'dynasty_item') {
            currentSubLines.push(line)
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              dynastyBlocks.set(currentSubId, stripHistoryFromTitleBlock(currentSubLines))
              subMode = 'dynasties_inner'
              subBraceDepth = 0
            }
          }
          continue
        }

        if (activeTopSection === 'faiths') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            const m = line.match(/^\t+(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [`${currentSubId}={`]
              subBraceDepth = 1
              subMode = 'faith_item'
            }
          } else if (subMode === 'faith_item') {
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              currentSubLines.push('}')
              faithBlocks.set(currentSubId, stripHistoryFromTitleBlock(currentSubLines))
              subMode = 'none'
              subBraceDepth = 0
            } else {
              currentSubLines.push(line)
            }
          }
          continue
        }

        if (activeTopSection === 'culture_manager') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            if (line === '\tcultures={') subMode = 'culture_inner'
          } else if (subMode === 'culture_inner') {
            if (line === '\t}') {
              subMode = 'none'
              continue
            }
            const m = line.match(/^\t*(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [`${currentSubId}={`]
              subBraceDepth = 1
              subMode = 'culture_item'
            }
          } else if (subMode === 'culture_item') {
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              currentSubLines.push('}')
              cultureBlocks.set(currentSubId, stripHistoryFromTitleBlock(currentSubLines))
              subMode = 'culture_inner'
              subBraceDepth = 0
            } else {
              currentSubLines.push(line)
            }
          }
          continue
        }

        if (activeTopSection === 'armies') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            if (line === '\tregiments={') subMode = 'regiments_inner'
          } else if (subMode === 'regiments_inner') {
            if (line === '\t}') {
              subMode = 'none'
              continue
            }
            const m = line.match(/^\t*(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [`${currentSubId}={`]
              subBraceDepth = 1
              subMode = 'regiment_item'
            }
          } else if (subMode === 'regiment_item') {
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              currentSubLines.push('}')
              const joined = currentSubLines.join('\n')
              if (joined.includes('type=') || joined.includes('owner=')) {
                regimentBlocks.set(currentSubId, joined)
              }
              subMode = 'regiments_inner'
              subBraceDepth = 0
            } else {
              currentSubLines.push(line)
            }
          }
          continue
        }

        if (activeTopSection === 'schemes') {
          if (subMode === 'none') {
            if (line === '}') {
              activeTopSection = ''
              continue
            }
            if (line === '\tactive={') subMode = 'schemes_active'
          } else if (subMode === 'schemes_active') {
            if (line === '\t}') {
              subMode = 'none'
              continue
            }
            const m = line.match(/^\t*(\d+)=\{$/)
            if (m) {
              currentSubId = Number(m[1])
              currentSubLines = [`${currentSubId}={`]
              subBraceDepth = 1
              subMode = 'scheme_item'
            }
          } else if (subMode === 'scheme_item') {
            subBraceDepth += countBraces(line)
            if (subBraceDepth <= 0) {
              currentSubLines.push('}')
              schemeBlocks.push(stripHistoryFromTitleBlock(currentSubLines))
              subMode = 'schemes_active'
              subBraceDepth = 0
            } else {
              currentSubLines.push(line)
            }
          }
        }
      }
    }

    if (zipHandle) {
      await zipHandle.close().catch(() => undefined)
      zipHandle = null
    }
    if (tempZipPath && fs.existsSync(tempZipPath)) {
      fs.unlinkSync(tempZipPath)
      tempZipPath = ''
    }

    // Step 3: Jomini WASM Parsing on extracted sections
    emitProgress('parsing-jomini', 56, 'Jomini WASM 엔진으로 핵심 데이터 구조화 중...')
    const jomini = await initJominiParser()
    locResolver = openLazyLocResolver(data.gameIndexDbPath)
    const localize = locResolver.localize

    const safeParseBlock = (text: string): Record<string, unknown> => {
      if (!text.trim()) return {}
      try {
        return jomini.parseText(text) as Record<string, unknown>
      } catch {
        return {}
      }
    }

    const metaRoot = safeParseBlock((capturedSections.get('meta_data') ?? []).join('\n'))
    const metaData = (metaRoot.meta_data as Record<string, unknown> | undefined) ?? {}

    const playedRoot = safeParseBlock(
      [
        ...(capturedSections.get('currently_played_characters') ?? []),
        ...(capturedSections.get('played_character') ?? [])
      ].join('\n')
    )

    const currentPlayedArr = toNumberArray(playedRoot.currently_played_characters)
    const playedCharObj = (playedRoot.played_character as Record<string, unknown> | undefined) ?? {}
    const playerCharacterId =
      currentPlayedArr[0] ??
      (typeof playedCharObj.character === 'number' ? playedCharObj.character : 0)

    const traitsRoot = safeParseBlock((capturedSections.get('traits_lookup') ?? []).join('\n'))
    const traitsLookup = toStringArray(traitsRoot.traits_lookup)

    // Parse CK3 1.20 Rites -> Faith mapping
    const ritesMap = new Map<number, { faithId: number; riteName: string }>()
    const ritesRoot = safeParseBlock((capturedSections.get('rites') ?? []).join('\n'))
    const ritesDb =
      ((ritesRoot.rites as Record<string, unknown> | undefined)?.database as
        | Record<string, unknown>
        | undefined) ?? {}
    for (const [rIdStr, rVal] of Object.entries(ritesDb)) {
      if (rVal && typeof rVal === 'object') {
        const rec = rVal as Record<string, unknown>
        const rData = (rec.data as Record<string, unknown> | undefined) ?? {}
        ritesMap.set(Number(rIdStr), {
          faithId: typeof rec.faith === 'number' ? rec.faith : Number(rIdStr),
          riteName: String(rData.name ?? rec.rite_type ?? '')
        })
      }
    }

    const gameDate = formatParadoxDate(metaData.meta_date) || '867.1.1'
    const saveGameVersion = String(metaData.version ?? '')
    const saveMods = toStringArray(metaData.mods)

    // Parse County Manager
    emitProgress('parsing-jomini', 61, '백작령 개발도 및 영지 홀딩 건물 파싱 중...')
    const countyMap = new Map<string, CountyMetaInfo>()
    const countyRoot = safeParseBlock((capturedSections.get('county_manager') ?? []).join('\n'))
    const countiesObj =
      ((countyRoot.county_manager as Record<string, unknown> | undefined)?.counties as
        | Record<string, unknown>
        | undefined) ?? {}

    for (const [cKey, cVal] of Object.entries(countiesObj)) {
      if (cVal && typeof cVal === 'object') {
        const rec = cVal as Record<string, unknown>
        countyMap.set(cKey, {
          development: Number(rec.development ?? 0),
          control: Number(rec.county_control ?? 100),
          cultureId: Number(rec.culture ?? 0),
          riteId: Number(rec.rite ?? rec.faith ?? 0)
        })
      }
    }

    // Parse Provinces (Holdings & Buildings)
    const provinceHoldingMap = new Map<number, ProvinceHoldingInfo>()
    const provChunks = R.chunk(provinceBlocks, JOMINI_CHUNK_SIZE)
    for (const batch of provChunks) {
      const joined = batch.map((b) => b.raw).join('\n')
      const parsed = safeParseBlock(joined)
      for (const [idStr, pVal] of Object.entries(parsed)) {
        const provId = Number(idStr)
        if (!pVal || typeof pVal !== 'object') continue
        const holding = (pVal as Record<string, unknown>).holding as
          | Record<string, unknown>
          | undefined
        if (!holding) continue
        const rawBlds = Array.isArray(holding.buildings) ? holding.buildings : []
        const buildings = R.pipe(
          rawBlds,
          R.map((b) =>
            b && typeof b === 'object' ? String((b as Record<string, unknown>).type ?? '') : ''
          ),
          R.filter((s) => s.length > 0),
          R.map((bKey) => localize(bKey, bKey))
        )
        provinceHoldingMap.set(provId, {
          holdingType: String(holding.type ?? ''),
          buildings,
          income: Number(holding.income ?? 0),
          levy: Number(holding.levy ?? 0)
        })
      }
    }

    // Parse Landed Titles
    emitProgress(
      'parsing-jomini',
      68,
      `작위 및 상속 구조 파싱 중 · ${titleStrippedBlocks.length.toLocaleString()}개...`
    )
    const parsedTitlesByNumId = new Map<number, ParsedTitleInfo>()
    const titleBatches = R.chunk(titleStrippedBlocks, JOMINI_CHUNK_SIZE)
    for (const batch of titleBatches) {
      const joined = batch.map((b) => b.rawBlock).join('\n')
      const parsed = safeParseBlock(joined)
      for (const [numIdStr, tVal] of Object.entries(parsed)) {
        if (!tVal || typeof tVal !== 'object') continue
        const rec = tVal as Record<string, unknown>
        const key = typeof rec.key === 'string' ? rec.key : ''
        if (!key) continue
        const nameData = rec.title_name_data as Record<string, unknown> | undefined
        const customName = typeof nameData?.name === 'string' ? nameData.name : ''

        parsedTitlesByNumId.set(Number(numIdStr), {
          numericId: Number(numIdStr),
          key,
          customName,
          holderId: typeof rec.holder === 'number' ? rec.holder : 0,
          deFactoLiegeNumId: typeof rec.de_facto_liege === 'number' ? rec.de_facto_liege : 0,
          deJureLiegeNumId: typeof rec.de_jure_liege === 'number' ? rec.de_jure_liege : 0,
          capitalProvinceId: typeof rec.capital === 'number' ? rec.capital : 0,
          heirIds: toNumberArray(rec.heir),
          laws: toStringArray(rec.laws)
        })
      }
    }

    // Parse Wars & Factions first so we also include war/faction participants in character set
    emitProgress('parsing-jomini', 74, '진행 중인 전쟁·파벌·모략 분석 중...')
    const warsRoot = safeParseBlock((capturedSections.get('wars') ?? []).join('\n'))
    const activeWarsObj =
      ((warsRoot.wars as Record<string, unknown> | undefined)?.active_wars as
        | Record<string, unknown>
        | undefined) ?? {}

    const factionsRoot = safeParseBlock((capturedSections.get('faction_manager') ?? []).join('\n'))
    const factionsObj =
      ((factionsRoot.faction_manager as Record<string, unknown> | undefined)?.factions as
        | Record<string, unknown>
        | undefined) ?? {}

    // Determine target character IDs to parse in full detail
    const priorityCharIds = new Set<number>(landedCharacterIds)
    if (playerCharacterId > 0) {
      priorityCharIds.add(playerCharacterId)
      const playerRaw = livingRawBlocks.get(playerCharacterId)
      if (playerRaw) {
        const pParsed = safeParseBlock(playerRaw)[String(playerCharacterId)] as
          | Record<string, unknown>
          | undefined
        if (pParsed) {
          const fam = pParsed.family_data as Record<string, unknown> | undefined
          for (const cid of toNumberArray(fam?.child)) priorityCharIds.add(cid)
          for (const sid of toNumberArray(fam?.spouse)) priorityCharIds.add(sid)
          if (typeof fam?.primary_spouse === 'number') priorityCharIds.add(fam.primary_spouse)

          const landed = pParsed.landed_data as Record<string, unknown> | undefined
          for (const cid of toNumberArray(landed?.council)) priorityCharIds.add(cid)
          for (const hid of toNumberArray(landed?.succession)) priorityCharIds.add(hid)

          const playable = pParsed.playable_data as Record<string, unknown> | undefined
          for (const kid of toNumberArray(playable?.knights)) priorityCharIds.add(kid)
        }
      }

      // Include player's courtiers (employer=<playerCharacterId>)
      const empToken = `employer=${playerCharacterId}`
      for (const [cid, rawBlock] of livingRawBlocks.entries()) {
        if (rawBlock.includes(empToken)) {
          priorityCharIds.add(cid)
        }
      }
    }

    // Parse priority characters in Jomini chunks
    const targetCharEntries = R.pipe(
      Array.from(priorityCharIds),
      R.filter((id) => livingRawBlocks.has(id)),
      R.map((id) => ({ id, raw: livingRawBlocks.get(id)! }))
    )

    emitProgress(
      'parsing-jomini',
      80,
      `주요 인물 및 영주 상세 파싱 중 · ${targetCharEntries.length.toLocaleString()}명...`
    )

    interface CharacterRowData {
      id: number
      firstName: string
      nickname: string
      birthDate: string
      age: number
      isPlayer: number
      isFemale: number
      diplomacy: number
      martial: number
      stewardship: number
      intrigue: number
      learning: number
      prowess: number
      gold: number
      monthlyIncome: number
      prestige: number
      piety: number
      dread: number
      stress: number
      faithId: number
      cultureId: number
      houseId: number
      dynastyId: number
      liegeId: number
      primaryTitle: string
      government: string
      lifestyle: string
      traitsJson: string
      claimsJson: string
      familyJson: string
      militaryStrength: number
      domainNumIds: number[]
      laws: string[]
      rawJson: string
    }

    // Build holder -> liege mapping via titles
    const holderPrimaryTitleMap = new Map<number, ParsedTitleInfo>()
    for (const tInfo of parsedTitlesByNumId.values()) {
      if (tInfo.holderId > 0 && !holderPrimaryTitleMap.has(tInfo.holderId)) {
        holderPrimaryTitleMap.set(tInfo.holderId, tInfo)
      }
    }

    const parsedCharacters = new Map<number, CharacterRowData>()
    const charBatches = R.chunk(targetCharEntries, JOMINI_CHUNK_SIZE)

    for (const batch of charBatches) {
      const joined = batch.map((b) => b.raw).join('\n')
      const parsed = safeParseBlock(joined)

      for (const [idStr, cVal] of Object.entries(parsed)) {
        const charId = Number(idStr)
        if (!cVal || typeof cVal !== 'object') continue
        const rec = cVal as Record<string, unknown>

        const skills = toNumberArray(rec.skill)
        const traitIndices = toNumberArray(rec.traits)
        const traitNames = R.pipe(
          traitIndices,
          R.map((idx) => traitsLookup[idx] ?? ''),
          R.filter((k) => k.length > 0),
          R.map((tKey) => localize(tKey, tKey))
        )

        const alive = (rec.alive_data as Record<string, unknown> | undefined) ?? {}
        const landed = (rec.landed_data as Record<string, unknown> | undefined) ?? {}
        const family = (rec.family_data as Record<string, unknown> | undefined) ?? {}

        const domainNumIds = toNumberArray(landed.domain)
        const primaryTitleNum = domainNumIds[0]
        const primaryTitleInfo = primaryTitleNum
          ? parsedTitlesByNumId.get(primaryTitleNum)
          : holderPrimaryTitleMap.get(charId)
        const primaryTitleKey = primaryTitleInfo?.key ?? ''

        // Determine liege character ID via deFactoLiege title holder or employer
        let liegeId = 0
        if (primaryTitleInfo && primaryTitleInfo.deFactoLiegeNumId > 0) {
          const liegeTitle = parsedTitlesByNumId.get(primaryTitleInfo.deFactoLiegeNumId)
          if (liegeTitle && liegeTitle.holderId !== charId) {
            liegeId = liegeTitle.holderId
          }
        } else if (typeof alive.employer === 'number' && alive.employer !== charId) {
          liegeId = alive.employer
        }

        const rawClaims = Array.isArray(alive.claim) ? alive.claim : []
        const claimKeys = R.pipe(
          rawClaims,
          R.map((cl) => {
            if (cl && typeof cl === 'object') {
              const tNum = Number((cl as Record<string, unknown>).title ?? 0)
              return parsedTitlesByNumId.get(tNum)?.key ?? ''
            }
            return ''
          }),
          R.filter((k) => k.length > 0)
        )

        const birthDate = formatParadoxDate(rec.birth)
        const rawFirstName = String(rec.first_name ?? '')
        const localizedFirstName = localize(rawFirstName, rawFirstName)
        const nickname =
          String(rec.nickname_text ?? '') ||
          (typeof rec.nickname === 'string' ? localize(rec.nickname) : '')

        const houseId = typeof rec.dynasty_house === 'number' ? rec.dynasty_house : 0
        const rawRiteId = typeof rec.rite === 'number' ? rec.rite : -1
        const resolvedFaithId =
          typeof rec.faith === 'number'
            ? rec.faith
            : rawRiteId >= 0
              ? (ritesMap.get(rawRiteId)?.faithId ?? rawRiteId)
              : 0

        parsedCharacters.set(charId, {
          id: charId,
          firstName: localizedFirstName,
          nickname,
          birthDate,
          age: calculateAge(birthDate, gameDate),
          isPlayer: charId === playerCharacterId ? 1 : 0,
          isFemale: rec.female === true || rec.female === 'yes' ? 1 : 0,
          diplomacy: skills[0] ?? 0,
          martial: skills[1] ?? 0,
          stewardship: skills[2] ?? 0,
          intrigue: skills[3] ?? 0,
          learning: skills[4] ?? 0,
          prowess: skills[5] ?? 0,
          gold: extractNumericCurrency(alive.gold),
          monthlyIncome: Number(Number(landed.balance ?? alive.income ?? 0).toFixed(2)),
          prestige: extractNumericCurrency(alive.prestige),
          piety: extractNumericCurrency(alive.piety),
          dread: Number(Number(landed.dread ?? 0).toFixed(1)),
          stress: Number(alive.stress ?? 0),
          faithId: resolvedFaithId,
          cultureId: Number(rec.culture ?? 0),
          houseId,
          dynastyId: 0,
          liegeId,
          primaryTitle: primaryTitleKey,
          government: String(landed.government ?? ''),
          lifestyle: String(alive.focus ?? alive.lifestyle ?? ''),
          traitsJson: JSON.stringify(traitNames),
          claimsJson: JSON.stringify(claimKeys),
          familyJson: JSON.stringify({
            spouse: family.primary_spouse ?? family.spouse,
            children: toNumberArray(family.child),
            successionHeirs: toNumberArray(landed.succession)
          }),
          militaryStrength: Number(landed.strength ?? landed.current_strength ?? 0),
          domainNumIds,
          laws: toStringArray(landed.laws),
          rawJson: JSON.stringify({
            domainLimit: landed.domain_limit,
            vassalLimit: landed.vassal_limit,
            vassalsTowardsLimit: landed.vassals_towards_limit,
            laws: toStringArray(landed.laws)
          })
        })
      }
    }

    // Parse Player House, Dynasty, Culture, Faith
    const playerChar = parsedCharacters.get(playerCharacterId)
    let houseName = String(metaData.meta_house_name ?? '')
    let dynastyName = houseName
    let renown = 0

    if (playerChar?.houseId && houseBlocks.has(playerChar.houseId)) {
      const hObj = safeParseBlock(houseBlocks.get(playerChar.houseId)!)[
        String(playerChar.houseId)
      ] as Record<string, unknown> | undefined
      if (hObj) {
        const rawHouseKey = String(hObj.name ?? hObj.localized_name ?? '')
        if (rawHouseKey) houseName = localize(rawHouseKey, houseName || rawHouseKey)
        const dynId = typeof hObj.dynasty === 'number' ? hObj.dynasty : 0
        playerChar.dynastyId = dynId
        if (dynId && dynastyBlocks.has(dynId)) {
          const dObj = safeParseBlock(dynastyBlocks.get(dynId)!)[String(dynId)] as
            | Record<string, unknown>
            | undefined
          if (dObj) {
            const rawDynKey = String(dObj.name ?? dObj.localized_name ?? '')
            dynastyName = localize(rawDynKey, houseName)
            renown = extractNumericCurrency(dObj.prestige)
          }
        }
      }
    }

    let cultureName = ''
    let cultureDetails: Record<string, unknown> = {}
    if (playerChar?.cultureId !== undefined && cultureBlocks.has(playerChar.cultureId)) {
      const cObj = safeParseBlock(cultureBlocks.get(playerChar.cultureId)!)[
        String(playerChar.cultureId)
      ] as Record<string, unknown> | undefined
      if (cObj) {
        const tpl = String(cObj.culture_template ?? '')
        cultureName = String(cObj.name ?? '') || localize(tpl, tpl)
        const traditions = toStringArray(cObj.traditions).map((t) => localize(t, t))
        const rawInnovs = Array.isArray(cObj.culture_innovation) ? cObj.culture_innovation : []
        const innovations = R.pipe(
          rawInnovs,
          R.map((inv) =>
            inv && typeof inv === 'object' ? String((inv as Record<string, unknown>).type ?? '') : ''
          ),
          R.filter((s) => s.length > 0),
          R.map((k) => localize(k, k))
        )
        cultureDetails = {
          template: tpl,
          ethos: cObj.ethos,
          heritage: cObj.heritage,
          martialCustom: cObj.martial_custom,
          traditions,
          innovations
        }
      }
    }

    let faithName = ''
    let faithDetails: Record<string, unknown> = {}
    if (playerChar?.faithId !== undefined && faithBlocks.has(playerChar.faithId)) {
      const fObj = safeParseBlock(faithBlocks.get(playerChar.faithId)!)[
        String(playerChar.faithId)
      ] as Record<string, unknown> | undefined
      if (fObj) {
        const tag = String(fObj.tag ?? fObj.faith_type ?? '')
        faithName = String(fObj.name ?? '') || localize(tag, tag)
        faithDetails = {
          tag,
          fervor: fObj.fervor,
          tenets: fObj.tenets,
          doctrine: toStringArray(fObj.doctrine)
        }
      }
    }

    // Parse Regiments (MAA)
    interface RegimentRow {
      id: number
      ownerId: number
      maaType: string
      localizedName: string
      size: number
      maxSize: number
      stationedCounty: string
    }
    const parsedRegiments: RegimentRow[] = []
    const regEntries = Array.from(regimentBlocks.entries())
    for (const batch of R.chunk(regEntries, JOMINI_CHUNK_SIZE)) {
      const joined = batch.map(([, raw]) => raw).join('\n')
      const parsed = safeParseBlock(joined)
      for (const [rIdStr, rVal] of Object.entries(parsed)) {
        if (!rVal || typeof rVal !== 'object') continue
        const rec = rVal as Record<string, unknown>
        const maaType = typeof rec.type === 'string' ? rec.type : ''
        if (!maaType) continue
        // owner 필드가 없는 용병/중립 연대를 플레이어 소유로 오집계하지 않도록 명시적 숫자만 인정
        const ownerId = typeof rec.owner === 'number' ? rec.owner : 0
        const chunks = Array.isArray(rec.chunks) ? rec.chunks : []
        const curSize =
          typeof rec.size === 'number'
            ? rec.size
            : R.sumBy(chunks, (ch) =>
                ch && typeof ch === 'object' ? Number((ch as Record<string, unknown>).current ?? 0) : 0
              )
        const maxSize =
          typeof rec.max === 'number'
            ? rec.max
            : R.sumBy(chunks, (ch) =>
                ch && typeof ch === 'object' ? Number((ch as Record<string, unknown>).max ?? 0) : 0
              )

        parsedRegiments.push({
          id: Number(rIdStr),
          ownerId,
          maaType,
          localizedName: localize(maaType),
          size: curSize,
          maxSize,
          stationedCounty: rec.origin ? `province_${rec.origin}` : ''
        })
      }
    }

    // Parse Schemes involving player
    interface SchemeRow {
      id: number
      schemeType: string
      ownerId: number
      targetId: number
      progress: number
      successChance: number
      secrecy: number
    }
    const parsedSchemes: SchemeRow[] = []
    for (const batch of R.chunk(schemeBlocks, JOMINI_CHUNK_SIZE)) {
      const parsed = safeParseBlock(batch.join('\n'))
      for (const [sIdStr, sVal] of Object.entries(parsed)) {
        if (!sVal || typeof sVal !== 'object') continue
        const rec = sVal as Record<string, unknown>
        const ownerId = Number(rec.scheme_owner ?? rec.owner ?? 0)
        const targetChar =
          rec.scheme_target && typeof rec.scheme_target === 'object'
            ? Number((rec.scheme_target as Record<string, unknown>).character ?? 0)
            : Number(rec.target ?? 0)
        if (
          playerCharacterId === 0 ||
          ownerId === playerCharacterId ||
          targetChar === playerCharacterId
        ) {
          parsedSchemes.push({
            id: Number(sIdStr),
            schemeType: String(rec.scheme_type ?? rec.type ?? ''),
            ownerId,
            targetId: targetChar,
            progress: Number(rec.progress ?? 0),
            successChance: Number(rec.success_chance ?? 0),
            secrecy: Number(rec.secrecy ?? 0)
          })
        }
      }
    }

    // Step 4: Write all parsed save data into save_state.db
    emitProgress('writing-db', 90, 'SQLite 세이브 데이터베이스 고속 적재 중...')

    const db = new Database(data.saveStateDbPath)
    let summary: SaveSummary

    try {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('busy_timeout = 10000')

      db.exec(`
        CREATE TABLE IF NOT EXISTS save_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS characters (
          id INTEGER PRIMARY KEY, first_name TEXT, nickname TEXT, birth_date TEXT, age INTEGER,
          is_player INTEGER DEFAULT 0, is_alive INTEGER DEFAULT 1, is_female INTEGER DEFAULT 0,
          diplomacy INTEGER DEFAULT 0, martial INTEGER DEFAULT 0, stewardship INTEGER DEFAULT 0,
          intrigue INTEGER DEFAULT 0, learning INTEGER DEFAULT 0, prowess INTEGER DEFAULT 0,
          gold REAL DEFAULT 0, monthly_income REAL DEFAULT 0, prestige REAL DEFAULT 0,
          piety REAL DEFAULT 0, dread REAL DEFAULT 0, stress INTEGER DEFAULT 0,
          faith_id INTEGER, culture_id INTEGER, house_id INTEGER, dynasty_id INTEGER,
          liege_id INTEGER, primary_title TEXT, government TEXT, lifestyle TEXT,
          traits_json TEXT, claims_json TEXT, family_json TEXT, military_strength INTEGER DEFAULT 0,
          raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS titles (
          title_key TEXT PRIMARY KEY, localized_name TEXT, holder_id INTEGER,
          de_jure_liege TEXT, de_facto_liege TEXT, tier TEXT, development REAL DEFAULT 0,
          county_culture_id INTEGER, county_faith_id INTEGER, buildings_json TEXT,
          succession_laws_json TEXT, heirs_json TEXT, raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS wars (
          id INTEGER PRIMARY KEY, name TEXT, casus_belli TEXT, start_date TEXT,
          main_attacker_id INTEGER, main_defender_id INTEGER, attackers_json TEXT,
          defenders_json TEXT, war_score REAL DEFAULT 0, raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS factions (
          id INTEGER PRIMARY KEY, faction_type TEXT, name TEXT, target_id INTEGER,
          leader_id INTEGER, discontent REAL DEFAULT 0, power_ratio REAL DEFAULT 0,
          members_json TEXT, raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS regiments (
          id INTEGER PRIMARY KEY, owner_id INTEGER, maa_type TEXT, localized_name TEXT,
          size INTEGER DEFAULT 0, max_size INTEGER DEFAULT 0, stationed_county TEXT, raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS faiths_cultures (
          kind TEXT NOT NULL, id INTEGER NOT NULL, key_name TEXT, display_name TEXT,
          details_json TEXT, PRIMARY KEY (kind, id)
        );
        CREATE TABLE IF NOT EXISTS active_schemes (
          id INTEGER PRIMARY KEY, scheme_type TEXT, owner_id INTEGER, target_id INTEGER,
          progress REAL DEFAULT 0, success_chance REAL DEFAULT 0, secrecy REAL DEFAULT 0, raw_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chars_liege ON characters(liege_id);
        CREATE INDEX IF NOT EXISTS idx_chars_player ON characters(is_player);
        CREATE INDEX IF NOT EXISTS idx_chars_name ON characters(first_name);
        CREATE INDEX IF NOT EXISTS idx_titles_holder ON titles(holder_id);
        CREATE INDEX IF NOT EXISTS idx_titles_liege ON titles(de_facto_liege);
        CREATE INDEX IF NOT EXISTS idx_titles_tier_dev ON titles(tier, development DESC);
        CREATE INDEX IF NOT EXISTS idx_factions_target ON factions(target_id);
        CREATE INDEX IF NOT EXISTS idx_regiments_owner ON regiments(owner_id);
        CREATE INDEX IF NOT EXISTS idx_schemes_owner ON active_schemes(owner_id);
        CREATE INDEX IF NOT EXISTS idx_schemes_target ON active_schemes(target_id);
      `)

      let playerWarCount = 0
      let dangerousFactionCount = 0

      const writeTransaction = db.transaction(() => {
        db.exec('DELETE FROM save_meta;')
        db.exec('DELETE FROM characters;')
        db.exec('DELETE FROM titles;')
        db.exec('DELETE FROM wars;')
        db.exec('DELETE FROM factions;')
        db.exec('DELETE FROM regiments;')
        db.exec('DELETE FROM faiths_cultures;')
        db.exec('DELETE FROM active_schemes;')

        const insertChar = db.prepare(`
          INSERT OR REPLACE INTO characters (
            id, first_name, nickname, birth_date, age, is_player, is_alive, is_female,
            diplomacy, martial, stewardship, intrigue, learning, prowess,
            gold, monthly_income, prestige, piety, dread, stress,
            faith_id, culture_id, house_id, dynasty_id, liege_id,
            primary_title, government, lifestyle, traits_json, claims_json, family_json,
            military_strength, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const ch of parsedCharacters.values()) {
          insertChar.run(
            ch.id,
            ch.firstName,
            ch.nickname,
            ch.birthDate,
            ch.age,
            ch.isPlayer,
            ch.isFemale,
            ch.diplomacy,
            ch.martial,
            ch.stewardship,
            ch.intrigue,
            ch.learning,
            ch.prowess,
            ch.gold,
            ch.monthlyIncome,
            ch.prestige,
            ch.piety,
            ch.dread,
            ch.stress,
            ch.faithId,
            ch.cultureId,
            ch.houseId,
            ch.dynastyId,
            ch.liegeId,
            ch.primaryTitle,
            ch.government,
            ch.lifestyle,
            ch.traitsJson,
            ch.claimsJson,
            ch.familyJson,
            ch.militaryStrength,
            ch.rawJson
          )
        }

        const insertTitle = db.prepare(`
          INSERT OR REPLACE INTO titles (
            title_key, localized_name, holder_id, de_jure_liege, de_facto_liege, tier,
            development, county_culture_id, county_faith_id, buildings_json,
            succession_laws_json, heirs_json, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const t of parsedTitlesByNumId.values()) {
          const countyMeta = countyMap.get(t.key)
          const capHolding = t.capitalProvinceId
            ? provinceHoldingMap.get(t.capitalProvinceId)
            : undefined
          const deJureKey = parsedTitlesByNumId.get(t.deJureLiegeNumId)?.key ?? ''
          const deFactoKey = parsedTitlesByNumId.get(t.deFactoLiegeNumId)?.key ?? ''
          const locName = t.customName || localize(t.key)

          insertTitle.run(
            t.key,
            locName,
            t.holderId,
            deJureKey,
            deFactoKey,
            inferTitleTier(t.key),
            countyMeta?.development ?? 0,
            countyMeta?.cultureId ?? 0,
            countyMeta?.riteId ?? 0,
            JSON.stringify(capHolding?.buildings ?? []),
            JSON.stringify(t.laws),
            JSON.stringify(t.heirIds),
            JSON.stringify({
              holdingType: capHolding?.holdingType,
              holdingIncome: capHolding?.income,
              countyControl: countyMeta?.control
            })
          )
        }

        const insertWar = db.prepare(`
          INSERT OR REPLACE INTO wars (
            id, name, casus_belli, start_date, main_attacker_id, main_defender_id,
            attackers_json, defenders_json, war_score, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const [wIdStr, wVal] of Object.entries(activeWarsObj)) {
          if (!wVal || typeof wVal !== 'object') continue
          const rec = wVal as Record<string, unknown>
          const atkParts = Array.isArray(
            (rec.attacker as Record<string, unknown> | undefined)?.participants
          )
            ? ((rec.attacker as Record<string, unknown>).participants as Array<
                Record<string, unknown>
              >)
            : []
          const defParts = Array.isArray(
            (rec.defender as Record<string, unknown> | undefined)?.participants
          )
            ? ((rec.defender as Record<string, unknown>).participants as Array<
                Record<string, unknown>
              >)
            : []

          const attackers = atkParts.map((p) => Number(p.character ?? 0)).filter(Boolean)
          const defenders = defParts.map((p) => Number(p.character ?? 0)).filter(Boolean)
          if (
            playerCharacterId > 0 &&
            (attackers.includes(playerCharacterId) || defenders.includes(playerCharacterId))
          ) {
            playerWarCount += 1
          }

          insertWar.run(
            Number(wIdStr),
            String(rec.name ?? rec.casus_belli ?? '전쟁'),
            String(rec.casus_belli ?? ''),
            formatParadoxDate(rec.start_date),
            attackers[0] ?? 0,
            defenders[0] ?? 0,
            JSON.stringify(attackers),
            JSON.stringify(defenders),
            Number(rec.war_score ?? 0),
            '{}'
          )
        }

        const insertFaction = db.prepare(`
          INSERT OR REPLACE INTO factions (
            id, faction_type, name, target_id, leader_id, discontent, power_ratio, members_json, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const [fIdStr, fVal] of Object.entries(factionsObj)) {
          if (!fVal || typeof fVal !== 'object') continue
          const rec = fVal as Record<string, unknown>
          const targetId = Number(rec.target ?? 0)
          const power = Number(rec.power ?? 0)
          const discontent = Number(rec.discontent ?? 0)
          if (targetId === playerCharacterId && (power >= 70 || discontent >= 50)) {
            dangerousFactionCount += 1
          }

          const rawMembers = Array.isArray(rec.members) ? rec.members : []
          const memberIds = R.pipe(
            rawMembers,
            R.map((m) =>
              m && typeof m === 'object'
                ? Number((m as Record<string, unknown>).character ?? 0)
                : Number(m)
            ),
            R.filter((n) => Number.isFinite(n) && n > 0)
          )

          insertFaction.run(
            Number(fIdStr),
            String(rec.type ?? ''),
            localize(String(rec.type ?? '')),
            targetId,
            Number(rec.leader ?? memberIds[0] ?? 0),
            discontent,
            power,
            JSON.stringify(memberIds),
            '{}'
          )
        }

        const insertReg = db.prepare(`
          INSERT OR REPLACE INTO regiments (
            id, owner_id, maa_type, localized_name, size, max_size, stationed_county, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
        `)
        for (const reg of parsedRegiments) {
          insertReg.run(
            reg.id,
            reg.ownerId,
            reg.maaType,
            reg.localizedName,
            reg.size,
            reg.maxSize,
            reg.stationedCounty
          )
        }

        const insertScheme = db.prepare(`
          INSERT OR REPLACE INTO active_schemes (
            id, scheme_type, owner_id, target_id, progress, success_chance, secrecy, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
        `)
        for (const sc of parsedSchemes) {
          insertScheme.run(
            sc.id,
            sc.schemeType,
            sc.ownerId,
            sc.targetId,
            sc.progress,
            sc.successChance,
            sc.secrecy
          )
        }

        const insertFc = db.prepare(`
          INSERT OR REPLACE INTO faiths_cultures (kind, id, key_name, display_name, details_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        if (playerChar?.faithId !== undefined) {
          insertFc.run(
            'faith',
            playerChar.faithId,
            String(faithDetails.tag ?? ''),
            faithName,
            JSON.stringify(faithDetails)
          )
        }
        if (playerChar?.cultureId !== undefined) {
          insertFc.run(
            'culture',
            playerChar.cultureId,
            String(cultureDetails.template ?? ''),
            cultureName,
            JSON.stringify(cultureDetails)
          )
        }

        const vassalCount = R.pipe(
          Array.from(parsedCharacters.values()),
          R.filter((c) => c.liegeId === playerCharacterId && c.primaryTitle.length > 0)
        ).length

        const domainCount = R.pipe(
          playerChar?.domainNumIds ?? [],
          R.map((nId) => parsedTitlesByNumId.get(nId)?.key ?? ''),
          R.filter((k) => k.startsWith('c_') || k.startsWith('b_'))
        ).length

        const primaryTitleKey = playerChar?.primaryTitle ?? ''
        const primaryTitleName =
          String(metaData.meta_title_name ?? '') || localize(primaryTitleKey, primaryTitleKey)
        const playerDisplayName =
          String(metaData.meta_player_name ?? '') ||
          (playerChar
            ? [playerChar.firstName, playerChar.nickname].filter(Boolean).join(' ')
            : '알 수 없는 군주')

        summary = {
          filePath: data.saveFilePath,
          fileName: path.basename(data.saveFilePath),
          parsedAt: new Date().toISOString(),
          gameDate,
          saveGameVersion,
          playerCharacterId,
          playerName: playerDisplayName,
          houseName,
          dynastyName,
          primaryTitleKey,
          primaryTitleName,
          governmentType: localize(playerChar?.government ?? '', playerChar?.government ?? ''),
          faithName,
          cultureName,
          age: playerChar?.age ?? 0,
          stress: playerChar?.stress ?? 0,
          gold: playerChar?.gold ?? 0,
          monthlyIncome: playerChar?.monthlyIncome ?? 0,
          prestige: playerChar?.prestige ?? 0,
          piety: playerChar?.piety ?? 0,
          renown,
          dread: playerChar?.dread ?? 0,
          militaryStrength: playerChar?.militaryStrength ?? 0,
          domainCount,
          vassalCount,
          activeWarCount: playerWarCount,
          dangerousFactionCount,
          skills: {
            diplomacy: playerChar?.diplomacy ?? 0,
            martial: playerChar?.martial ?? 0,
            stewardship: playerChar?.stewardship ?? 0,
            intrigue: playerChar?.intrigue ?? 0,
            learning: playerChar?.learning ?? 0,
            prowess: playerChar?.prowess ?? 0
          },
          traits: playerChar ? (JSON.parse(playerChar.traitsJson) as string[]) : [],
          saveMods
        }

        db.prepare('INSERT OR REPLACE INTO save_meta (key, value) VALUES (?, ?)').run(
          'summary_json',
          JSON.stringify(summary)
        )
      })

      writeTransaction()
    } finally {
      db.close()
    }

    emitProgress(
      'completed',
      100,
      `세이브 로드 완료 · ${summary!.playerName} · ${summary!.primaryTitleName} · ${summary!.gameDate}`
    )
    parentPort?.postMessage({ type: 'result', summary: summary! })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    emitProgress('error', 0, errMsg, 0, 0, errMsg)
    parentPort?.postMessage({ type: 'error', error: errMsg })
  } finally {
    locResolver?.close()
    if (zipHandle) {
      await zipHandle.close().catch(() => undefined)
      zipHandle = null
    }
    if (tempZipPath && fs.existsSync(tempZipPath)) {
      try {
        fs.unlinkSync(tempZipPath)
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

void runSaveParsePipeline()
