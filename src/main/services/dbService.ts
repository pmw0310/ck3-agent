import fs from 'node:fs'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import * as R from 'remeda'
import { EMBEDDING_DIMENSIONS } from '@shared/constants'
import type { SaveSummary, VersionSnapshot } from '@shared/types'
import { getGameIndexDbPath, getSaveStateDbPath } from '@/main/services/configService'

export interface ScriptSearchResultItem {
  id: number
  category: string
  entryKey: string
  titleKo: string
  descKo: string
  sourceMod: string
  filePath: string
  summaryText: string
  score: number
}

export interface ScriptDetailItem {
  id: number
  category: string
  entryKey: string
  titleKo: string
  descKo: string
  sourceMod: string
  filePath: string
  summaryText: string
  rawScript: string
  parsedJson: Record<string, unknown>
}

export interface CharacterQueryFilter {
  relation?: 'player' | 'vassals' | 'courtiers' | 'heirs' | 'all'
  searchName?: string
  characterIds?: number[]
  sortBy?: 'military_strength' | 'stewardship' | 'martial' | 'diplomacy' | 'intrigue' | 'learning' | 'prowess' | 'gold'
  limit?: number
}

export interface TitleQueryFilter {
  scope?: 'player_domain' | 'player_vassals' | 'specific_keys' | 'top_development'
  titleKeys?: string[]
  limit?: number
}

let gameIndexDb: Database.Database | null = null
let saveStateDb: Database.Database | null = null
const indexCountsCache = new Map<string, { scriptCount: number; locCount: number }>()

/**
 * `better-sqlite3` 연결에 `sqlite-vec` 벡터 확장을 로드하며 패키징(`app.asar.unpacked`) 경로를 자동 보정합니다.
 */
export const loadSqliteVecOnConnection = (db: Database.Database): void => {
  try {
    sqliteVec.load(db)
  } catch {
    const rawPath = sqliteVec.getLoadablePath()
    const unpackedPath = rawPath.replace('app.asar', 'app.asar.unpacked')
    db.loadExtension(unpackedPath)
  }
}

export const ensureGameIndexSchema = (db: Database.Database): void => {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 8000')

  loadSqliteVecOnConnection(db)

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

    CREATE INDEX IF NOT EXISTS idx_script_entries_key ON script_entries(entry_key);
    CREATE INDEX IF NOT EXISTS idx_script_entries_cat ON script_entries(category);
    CREATE INDEX IF NOT EXISTS idx_script_entries_title ON script_entries(title_ko);

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
}

export const ensureSaveStateSchema = (db: Database.Database): void => {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 8000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS save_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY,
      first_name TEXT,
      nickname TEXT,
      birth_date TEXT,
      age INTEGER,
      is_player INTEGER DEFAULT 0,
      is_alive INTEGER DEFAULT 1,
      is_female INTEGER DEFAULT 0,
      diplomacy INTEGER DEFAULT 0,
      martial INTEGER DEFAULT 0,
      stewardship INTEGER DEFAULT 0,
      intrigue INTEGER DEFAULT 0,
      learning INTEGER DEFAULT 0,
      prowess INTEGER DEFAULT 0,
      gold REAL DEFAULT 0,
      monthly_income REAL DEFAULT 0,
      prestige REAL DEFAULT 0,
      piety REAL DEFAULT 0,
      dread REAL DEFAULT 0,
      stress INTEGER DEFAULT 0,
      faith_id INTEGER,
      culture_id INTEGER,
      house_id INTEGER,
      dynasty_id INTEGER,
      liege_id INTEGER,
      primary_title TEXT,
      government TEXT,
      lifestyle TEXT,
      traits_json TEXT,
      claims_json TEXT,
      family_json TEXT,
      military_strength INTEGER DEFAULT 0,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chars_liege ON characters(liege_id);
    CREATE INDEX IF NOT EXISTS idx_chars_player ON characters(is_player);
    CREATE INDEX IF NOT EXISTS idx_chars_name ON characters(first_name);

    CREATE TABLE IF NOT EXISTS titles (
      title_key TEXT PRIMARY KEY,
      localized_name TEXT,
      holder_id INTEGER,
      de_jure_liege TEXT,
      de_facto_liege TEXT,
      tier TEXT,
      development REAL DEFAULT 0,
      county_culture_id INTEGER,
      county_faith_id INTEGER,
      buildings_json TEXT,
      succession_laws_json TEXT,
      heirs_json TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_titles_holder ON titles(holder_id);
    CREATE INDEX IF NOT EXISTS idx_titles_liege ON titles(de_facto_liege);
    CREATE INDEX IF NOT EXISTS idx_titles_tier_dev ON titles(tier, development DESC);

    CREATE TABLE IF NOT EXISTS wars (
      id INTEGER PRIMARY KEY,
      name TEXT,
      casus_belli TEXT,
      start_date TEXT,
      main_attacker_id INTEGER,
      main_defender_id INTEGER,
      attackers_json TEXT,
      defenders_json TEXT,
      war_score REAL DEFAULT 0,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS factions (
      id INTEGER PRIMARY KEY,
      faction_type TEXT,
      name TEXT,
      target_id INTEGER,
      leader_id INTEGER,
      discontent REAL DEFAULT 0,
      power_ratio REAL DEFAULT 0,
      members_json TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_factions_target ON factions(target_id);

    CREATE TABLE IF NOT EXISTS regiments (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER,
      maa_type TEXT,
      localized_name TEXT,
      size INTEGER DEFAULT 0,
      max_size INTEGER DEFAULT 0,
      stationed_county TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_regiments_owner ON regiments(owner_id);

    CREATE TABLE IF NOT EXISTS faiths_cultures (
      kind TEXT NOT NULL,
      id INTEGER NOT NULL,
      key_name TEXT,
      display_name TEXT,
      details_json TEXT,
      PRIMARY KEY (kind, id)
    );

    CREATE TABLE IF NOT EXISTS active_schemes (
      id INTEGER PRIMARY KEY,
      scheme_type TEXT,
      owner_id INTEGER,
      target_id INTEGER,
      progress REAL DEFAULT 0,
      success_chance REAL DEFAULT 0,
      secrecy REAL DEFAULT 0,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_schemes_owner ON active_schemes(owner_id);
    CREATE INDEX IF NOT EXISTS idx_schemes_target ON active_schemes(target_id);

    CREATE TABLE IF NOT EXISTS dynasties_houses (
      kind TEXT NOT NULL,
      id INTEGER NOT NULL,
      key_name TEXT,
      display_name TEXT,
      head_id INTEGER,
      renown REAL DEFAULT 0,
      details_json TEXT,
      PRIMARY KEY (kind, id)
    );
  `)
}

export const getGameIndexDb = (): Database.Database => {
  if (!gameIndexDb || !gameIndexDb.open) {
    gameIndexDb = new Database(getGameIndexDbPath())
    ensureGameIndexSchema(gameIndexDb)
  }
  return gameIndexDb
}

export const getSaveStateDb = (): Database.Database => {
  if (!saveStateDb || !saveStateDb.open) {
    saveStateDb = new Database(getSaveStateDbPath())
    ensureSaveStateSchema(saveStateDb)
  }
  return saveStateDb
}

/** 듀얼 SQLite 데이터베이스(`game_index.db`, `save_state.db`)를 초기화합니다. */
export const initDatabases = (): void => {
  indexCountsCache.clear()
  getGameIndexDb()
  getSaveStateDb()
}

/** 열려 있는 모든 SQLite 데이터베이스 핸들을 안전하게 닫습니다. */
export const closeAllDatabases = (): void => {
  indexCountsCache.clear()
  if (gameIndexDb?.open) {
    gameIndexDb.close()
  }
  gameIndexDb = null

  if (saveStateDb?.open) {
    saveStateDb.close()
  }
  saveStateDb = null
}

/** 세이브 워커 적재 완료 후 메인 프로세스의 `save_state.db` 연결을 새로 고칩니다. */
export const refreshSaveDbConnection = (): void => {
  if (saveStateDb?.open) {
    saveStateDb.close()
  }
  saveStateDb = null
  getSaveStateDb()
}

/** 인덱싱 워커 완료 후 메인 프로세스의 `game_index.db` 연결 및 카운트 캐시를 새로 고칩니다. */
export const refreshIndexDbConnection = (): void => {
  indexCountsCache.clear()
  if (gameIndexDb?.open) {
    gameIndexDb.close()
  }
  gameIndexDb = null
  getGameIndexDb()
}

/**
 * `game_index.db`에 저장된 직전 버전 스냅샷 메타데이터를 조회합니다.
 */
export const getStoredVersionSnapshot = (): VersionSnapshot | null => {
  try {
    const dbPath = getGameIndexDbPath()
    if (!fs.existsSync(dbPath)) return null
    const db = getGameIndexDb()
    const row = db
      .prepare('SELECT value FROM meta_state WHERE key = ?')
      .get('version_snapshot') as { value?: string } | undefined
    if (!row?.value) return null
    return JSON.parse(row.value) as VersionSnapshot
  } catch {
    return null
  }
}

/**
 * 인덱싱된 스크립트 및 로컬라이제이션 총 건수를 반환합니다.
 */
export const getIndexCounts = (): { scriptCount: number; locCount: number } => {
  try {
    const dbPath = getGameIndexDbPath()
    if (!fs.existsSync(dbPath)) {
      indexCountsCache.delete(dbPath)
      return { scriptCount: 0, locCount: 0 }
    }
    const cached = indexCountsCache.get(dbPath)
    if (cached && cached.scriptCount > 0) {
      return cached
    }
    const db = getGameIndexDb()
    const scriptRow = db.prepare('SELECT COUNT(*) as cnt FROM script_entries').get() as {
      cnt: number
    }
    const locRow = db.prepare('SELECT COUNT(*) as cnt FROM localization').get() as {
      cnt: number
    }
    const result = {
      scriptCount: scriptRow?.cnt ?? 0,
      locCount: locRow?.cnt ?? 0
    }
    if (result.scriptCount > 0 || result.locCount > 0) {
      indexCountsCache.set(dbPath, result)
    }
    return result
  } catch {
    return { scriptCount: 0, locCount: 0 }
  }
}

export const getCurrentSaveSummary = (): SaveSummary | null => {
  try {
    const dbPath = getSaveStateDbPath()
    if (!fs.existsSync(dbPath)) return null
    const db = getSaveStateDb()
    const row = db
      .prepare('SELECT value FROM save_meta WHERE key = ?')
      .get('summary_json') as { value?: string } | undefined
    if (!row?.value) return null
    return JSON.parse(row.value) as SaveSummary
  } catch {
    return null
  }
}

export const lookupLocalizationMap = (
  keys: string[]
): Record<string, { ko: string; en: string; sourceMod: string }> => {
  const uniqueKeys = R.pipe(
    keys,
    R.map((k) => k.trim()),
    R.filter((k) => k.length > 0),
    R.unique()
  )
  if (uniqueKeys.length === 0) return {}

  const db = getGameIndexDb()
  const result: Record<string, { ko: string; en: string; sourceMod: string }> = {}

  const chunks = R.chunk(uniqueKeys, 200)
  for (const batch of chunks) {
    const placeholders = batch.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT loc_key, text_ko, text_en, source_mod FROM localization WHERE loc_key IN (${placeholders})`
      )
      .all(...batch) as Array<{
      loc_key: string
      text_ko: string | null
      text_en: string | null
      source_mod: string | null
    }>

    for (const row of rows) {
      result[row.loc_key] = {
        ko: row.text_ko || row.text_en || row.loc_key,
        en: row.text_en || row.loc_key,
        sourceMod: row.source_mod || 'Vanilla'
      }
    }
  }

  return result
}

export const searchScriptsHybrid = (params: {
  queryEmbedding: Float32Array | null
  keywordQuery: string
  category?: string
  limit?: number
}): ScriptSearchResultItem[] => {
  const db = getGameIndexDb()
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 25)
  const categoryFilter = params.category?.trim() || ''

  const vectorRanks = new Map<number, number>()
  const lexicalRanks = new Map<number, number>()

  if (params.queryEmbedding && params.queryEmbedding.length === EMBEDDING_DIMENSIONS) {
    try {
      const vecRows = db
        .prepare(
          `SELECT rowid, vec_distance_l2(embedding, ?) AS distance
           FROM script_vec
           ORDER BY distance ASC
           LIMIT ?`
        )
        .all(Buffer.from(params.queryEmbedding.buffer), limit * 4) as Array<{
        rowid: number
        distance: number
      }>

      vecRows.forEach((row, idx) => {
        vectorRanks.set(Number(row.rowid), idx + 1)
      })
    } catch {
      // Fallback to lexical if vector table is empty
    }
  }

  const cleanedKeywords = R.pipe(
    params.keywordQuery.split(/[\s,()[\]"':;!?/\\]+/),
    R.map((tok) => tok.trim()),
    R.filter((tok) => tok.length >= 2),
    R.take(8)
  )

  if (cleanedKeywords.length > 0) {
    try {
      const ftsExpr = cleanedKeywords.map((tok) => `"${tok.replace(/"/g, '')}"*`).join(' OR ')
      const ftsRows = db
        .prepare(
          `SELECT rowid
           FROM script_fts
           WHERE script_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsExpr, limit * 4) as Array<{ rowid: number }>

      ftsRows.forEach((row, idx) => {
        lexicalRanks.set(Number(row.rowid), idx + 1)
      })
    } catch {
      const likePattern = `%${cleanedKeywords[0]}%`
      const likeRows = db
        .prepare(
          `SELECT id AS rowid FROM script_entries
           WHERE entry_key LIKE ? OR title_ko LIKE ? OR summary_text LIKE ?
           LIMIT ?`
        )
        .all(likePattern, likePattern, likePattern, limit * 3) as Array<{ rowid: number }>

      likeRows.forEach((row, idx) => {
        lexicalRanks.set(Number(row.rowid), idx + 1)
      })
    }
  }

  const candidateIds = R.pipe(
    [...Array.from(vectorRanks.keys()), ...Array.from(lexicalRanks.keys())],
    R.unique()
  )

  if (candidateIds.length === 0) return []

  const placeholders = candidateIds.map(() => '?').join(',')
  const sql = categoryFilter
    ? `SELECT id, category, entry_key, title_ko, desc_ko, source_mod, file_path, summary_text
       FROM script_entries
       WHERE id IN (${placeholders}) AND category = ?`
    : `SELECT id, category, entry_key, title_ko, desc_ko, source_mod, file_path, summary_text
       FROM script_entries
       WHERE id IN (${placeholders})`

  const bindArgs = categoryFilter ? [...candidateIds, categoryFilter] : candidateIds
  const entryRows = db.prepare(sql).all(...bindArgs) as Array<{
    id: number
    category: string
    entry_key: string
    title_ko: string | null
    desc_ko: string | null
    source_mod: string
    file_path: string
    summary_text: string
  }>

  const RRF_K = 60

  return R.pipe(
    entryRows,
    R.map((row) => {
      const vRank = vectorRanks.get(row.id)
      const lRank = lexicalRanks.get(row.id)
      const vScore = vRank ? 1 / (RRF_K + vRank) : 0
      const lScore = lRank ? 1.25 / (RRF_K + lRank) : 0
      return {
        id: row.id,
        category: row.category,
        entryKey: row.entry_key,
        titleKo: row.title_ko || row.entry_key,
        descKo: row.desc_ko || '',
        sourceMod: row.source_mod,
        filePath: row.file_path,
        summaryText: row.summary_text,
        score: Number((vScore + lScore).toFixed(5))
      }
    }),
    R.sortBy([(item) => item.score, 'desc']),
    R.take(limit)
  )
}

export const getScriptEntriesByKey = (
  entryKey: string,
  category?: string
): ScriptDetailItem[] => {
  const db = getGameIndexDb()
  const trimmedKey = entryKey.trim()
  if (!trimmedKey) return []

  const rows = (
    category
      ? db
          .prepare(
            `SELECT id, category, entry_key, title_ko, desc_ko, source_mod, file_path, summary_text, raw_script, parsed_json
             FROM script_entries
             WHERE (entry_key = ? OR entry_key LIKE ? OR title_ko = ?) AND category = ?
             LIMIT 5`
          )
          .all(trimmedKey, `%${trimmedKey}%`, trimmedKey, category)
      : db
          .prepare(
            `SELECT id, category, entry_key, title_ko, desc_ko, source_mod, file_path, summary_text, raw_script, parsed_json
             FROM script_entries
             WHERE entry_key = ? OR entry_key LIKE ? OR title_ko = ?
             ORDER BY CASE WHEN entry_key = ? THEN 0 ELSE 1 END
             LIMIT 5`
          )
          .all(trimmedKey, `%${trimmedKey}%`, trimmedKey, trimmedKey)
  ) as Array<{
    id: number
    category: string
    entry_key: string
    title_ko: string | null
    desc_ko: string | null
    source_mod: string
    file_path: string
    summary_text: string
    raw_script: string
    parsed_json: string
  }>

  return R.pipe(
    rows,
    R.map((row) => ({
      id: row.id,
      category: row.category,
      entryKey: row.entry_key,
      titleKo: row.title_ko || row.entry_key,
      descKo: row.desc_ko || '',
      sourceMod: row.source_mod,
      filePath: row.file_path,
      summaryText: row.summary_text,
      rawScript: row.raw_script.slice(0, 4000),
      parsedJson: (() => {
        try {
          if (row.parsed_json.length > 6000) {
            return { truncatedJsonPreview: `${row.parsed_json.slice(0, 6000)}…` }
          }
          return JSON.parse(row.parsed_json) as Record<string, unknown>
        } catch {
          return {}
        }
      })()
    }))
  )
}

export const querySaveCharacters = (filter: CharacterQueryFilter): Array<Record<string, unknown>> => {
  const db = getSaveStateDb()
  const summary = getCurrentSaveSummary()
  const playerId = summary?.playerCharacterId ?? 0
  const limit = Math.min(Math.max(filter.limit ?? 15, 1), 50)

  const allowedSorts = new Set([
    'military_strength',
    'stewardship',
    'martial',
    'diplomacy',
    'intrigue',
    'learning',
    'prowess',
    'gold'
  ])
  const sortCol =
    filter.sortBy && allowedSorts.has(filter.sortBy) ? filter.sortBy : 'military_strength'

  let rows: Array<Record<string, unknown>> = []

  if (filter.characterIds && filter.characterIds.length > 0) {
    const ids = R.take(filter.characterIds, 30)
    const placeholders = ids.map(() => '?').join(',')
    rows = db
      .prepare(`SELECT * FROM characters WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>
  } else if (filter.relation === 'player' && playerId > 0) {
    rows = db.prepare('SELECT * FROM characters WHERE id = ?').all(playerId) as Array<
      Record<string, unknown>
    >
  } else if (filter.relation === 'vassals' && playerId > 0) {
    rows = db
      .prepare(
        `SELECT * FROM characters
         WHERE liege_id = ? AND primary_title IS NOT NULL AND primary_title != ''
         ORDER BY ${sortCol} DESC
         LIMIT ?`
      )
      .all(playerId, limit) as Array<Record<string, unknown>>
  } else if (filter.relation === 'courtiers' && playerId > 0) {
    rows = db
      .prepare(
        `SELECT * FROM characters
         WHERE liege_id = ? AND (primary_title IS NULL OR primary_title = '')
         ORDER BY ${sortCol} DESC
         LIMIT ?`
      )
      .all(playerId, limit) as Array<Record<string, unknown>>
  } else if (filter.relation === 'heirs' && playerId > 0) {
    const playerRow = db
      .prepare('SELECT family_json FROM characters WHERE id = ?')
      .get(playerId) as { family_json?: string } | undefined
    const family = playerRow?.family_json
      ? (JSON.parse(playerRow.family_json) as { children?: number[]; spouse?: number })
      : {}
    const targetIds = R.pipe(
      [...(family.children ?? []), ...(family.spouse ? [family.spouse] : [])],
      R.unique(),
      R.take(25)
    )
    if (targetIds.length > 0) {
      const placeholders = targetIds.map(() => '?').join(',')
      rows = db
        .prepare(`SELECT * FROM characters WHERE id IN (${placeholders})`)
        .all(...targetIds) as Array<Record<string, unknown>>
    }
  } else if (filter.searchName) {
    const pat = `%${filter.searchName.trim()}%`
    rows = db
      .prepare(
        `SELECT * FROM characters
         WHERE first_name LIKE ? OR primary_title LIKE ?
         ORDER BY ${sortCol} DESC
         LIMIT ?`
      )
      .all(pat, pat, limit) as Array<Record<string, unknown>>
  } else {
    rows = db
      .prepare(`SELECT * FROM characters ORDER BY ${sortCol} DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>
  }

  return R.pipe(
    rows,
    R.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      nickname: row.nickname,
      age: row.age,
      isPlayer: Boolean(row.is_player),
      isFemale: Boolean(row.is_female),
      skills: {
        diplomacy: row.diplomacy,
        martial: row.martial,
        stewardship: row.stewardship,
        intrigue: row.intrigue,
        learning: row.learning,
        prowess: row.prowess
      },
      gold: row.gold,
      monthlyIncome: row.monthly_income,
      prestige: row.prestige,
      piety: row.piety,
      dread: row.dread,
      stress: row.stress,
      primaryTitle: row.primary_title,
      government: row.government,
      lifestyle: row.lifestyle,
      liegeId: row.liege_id,
      militaryStrength: row.military_strength,
      traits: row.traits_json ? JSON.parse(String(row.traits_json)) : [],
      claims: row.claims_json ? JSON.parse(String(row.claims_json)) : [],
      family: row.family_json ? JSON.parse(String(row.family_json)) : {}
    }))
  )
}

export const querySaveRealmAndTitles = (
  filter: TitleQueryFilter
): {
  titles: Array<Record<string, unknown>>
  faithAndCulture: Array<Record<string, unknown>>
} => {
  const db = getSaveStateDb()
  const summary = getCurrentSaveSummary()
  const playerId = summary?.playerCharacterId ?? 0
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 60)

  let titleRows: Array<Record<string, unknown>> = []

  if (filter.scope === 'specific_keys' && filter.titleKeys && filter.titleKeys.length > 0) {
    const keys = R.take(filter.titleKeys, 30)
    const placeholders = keys.map(() => '?').join(',')
    titleRows = db
      .prepare(`SELECT * FROM titles WHERE title_key IN (${placeholders})`)
      .all(...keys) as Array<Record<string, unknown>>
  } else if (filter.scope === 'player_vassals' && playerId > 0) {
    titleRows = db
      .prepare(
        `SELECT t.* FROM titles t
         INNER JOIN characters c ON t.holder_id = c.id
         WHERE c.liege_id = ?
         ORDER BY t.development DESC
         LIMIT ?`
      )
      .all(playerId, limit) as Array<Record<string, unknown>>
  } else if (filter.scope === 'top_development') {
    titleRows = db
      .prepare(`SELECT * FROM titles WHERE tier = 'county' ORDER BY development DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>
  } else if (playerId > 0) {
    titleRows = db
      .prepare(`SELECT * FROM titles WHERE holder_id = ? ORDER BY development DESC LIMIT ?`)
      .all(playerId, limit) as Array<Record<string, unknown>>
  }

  const playerChar = playerId
    ? (db
        .prepare('SELECT faith_id, culture_id FROM characters WHERE id = ?')
        .get(playerId) as { faith_id?: number; culture_id?: number } | undefined)
    : undefined

  const faithCultureRows: Array<Record<string, unknown>> = []
  if (playerChar?.faith_id) {
    const fRow = db
      .prepare('SELECT * FROM faiths_cultures WHERE kind = ? AND id = ?')
      .get('faith', playerChar.faith_id) as Record<string, unknown> | undefined
    if (fRow) faithCultureRows.push(fRow)
  }
  if (playerChar?.culture_id) {
    const cRow = db
      .prepare('SELECT * FROM faiths_cultures WHERE kind = ? AND id = ?')
      .get('culture', playerChar.culture_id) as Record<string, unknown> | undefined
    if (cRow) faithCultureRows.push(cRow)
  }

  return {
    titles: R.pipe(
      titleRows,
      R.map((row) => ({
        titleKey: row.title_key,
        localizedName: row.localized_name,
        holderId: row.holder_id,
        tier: row.tier,
        deJureLiege: row.de_jure_liege,
        deFactoLiege: row.de_facto_liege,
        development: row.development,
        buildings: row.buildings_json ? JSON.parse(String(row.buildings_json)) : [],
        successionLaws: row.succession_laws_json
          ? JSON.parse(String(row.succession_laws_json))
          : [],
        heirs: row.heirs_json ? JSON.parse(String(row.heirs_json)) : []
      }))
    ),
    faithAndCulture: R.pipe(
      faithCultureRows,
      R.map((row) => ({
        kind: row.kind,
        id: row.id,
        keyName: row.key_name,
        displayName: row.display_name,
        details: row.details_json ? JSON.parse(String(row.details_json)) : {}
      }))
    )
  }
}

export const querySaveWarsFactionsAndRegiments = (): {
  wars: Array<Record<string, unknown>>
  factions: Array<Record<string, unknown>>
  regiments: Array<Record<string, unknown>>
  schemes: Array<Record<string, unknown>>
} => {
  const db = getSaveStateDb()
  const summary = getCurrentSaveSummary()
  const playerId = summary?.playerCharacterId ?? 0

  const warRows = db
    .prepare('SELECT * FROM wars LIMIT 30')
    .all() as Array<Record<string, unknown>>

  const factionRows = (
    playerId > 0
      ? db
          .prepare('SELECT * FROM factions WHERE target_id = ? ORDER BY power_ratio DESC LIMIT 20')
          .all(playerId)
      : db.prepare('SELECT * FROM factions ORDER BY power_ratio DESC LIMIT 20').all()
  ) as Array<Record<string, unknown>>

  const regimentRows = (
    playerId > 0
      ? db
          .prepare(
            'SELECT * FROM regiments WHERE owner_id = ? ORDER BY max_size DESC, size DESC LIMIT 40'
          )
          .all(playerId)
      : db.prepare('SELECT * FROM regiments ORDER BY max_size DESC, size DESC LIMIT 25').all()
  ) as Array<Record<string, unknown>>

  const schemeRows = (
    playerId > 0
      ? db
          .prepare('SELECT * FROM active_schemes WHERE owner_id = ? OR target_id = ? LIMIT 20')
          .all(playerId, playerId)
      : db.prepare('SELECT * FROM active_schemes LIMIT 20').all()
  ) as Array<Record<string, unknown>>

  return {
    wars: R.pipe(
      warRows,
      R.map((w) => ({
        id: w.id,
        name: w.name,
        casusBelli: w.casus_belli,
        startDate: w.start_date,
        mainAttackerId: w.main_attacker_id,
        mainDefenderId: w.main_defender_id,
        warScore: w.war_score,
        attackers: w.attackers_json ? JSON.parse(String(w.attackers_json)) : [],
        defenders: w.defenders_json ? JSON.parse(String(w.defenders_json)) : []
      }))
    ),
    factions: R.pipe(
      factionRows,
      R.map((f) => ({
        id: f.id,
        factionType: f.faction_type,
        name: f.name,
        targetId: f.target_id,
        leaderId: f.leader_id,
        discontent: f.discontent,
        powerRatio: f.power_ratio,
        members: f.members_json ? JSON.parse(String(f.members_json)) : []
      }))
    ),
    regiments: R.pipe(
      regimentRows,
      R.map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        maaType: r.maa_type,
        localizedName: r.localized_name,
        size: r.size,
        maxSize: r.max_size,
        stationedCounty: r.stationed_county
      }))
    ),
    schemes: R.pipe(
      schemeRows,
      R.map((s) => ({
        id: s.id,
        schemeType: s.scheme_type,
        ownerId: s.owner_id,
        targetId: s.target_id,
        progress: s.progress,
        successChance: s.success_chance,
        secrecy: s.secrecy
      }))
    )
  }
}
