import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { Jomini } from 'jomini'
import * as R from 'remeda'
import { INDEX_TARGET_CATEGORIES, PRESET_PROMPTS } from '@/shared/constants'

/**
 * ck3-agent 핵심 파이프라인(경로 탐지, Jomini WASM, Electron SQLite-Vec) 원스톱 검증 스크립트
 */
const runVerification = async (): Promise<void> => {
  console.log('ℹ️ [Verify] 1. CK3 사용자 문서 폴더 및 상수 구성 점검...')
  const defaultDocDir = path.join(
    os.homedir(),
    'Documents',
    'Paradox Interactive',
    'Crusader Kings III'
  )
  console.log('   - 기본 CK3 문서 경로 존재 여부:', fs.existsSync(defaultDocDir))
  console.log(
    '   - 인덱싱 대상 카테고리 수:',
    INDEX_TARGET_CATEGORIES.length,
    '| 전략 프리셋 수:',
    PRESET_PROMPTS.length
  )

  console.log('ℹ️ [Verify] 2. Jomini WASM 파서 및 Remeda 파이프라인 점검...')
  const parser = await Jomini.initialize()
  const parsed = parser.parseText('test_decision={ major=yes cost={ gold=250 } }') as Record<
    string,
    unknown
  >
  const keys = R.pipe(Object.keys(parsed), R.filter((k) => k.length > 0))
  if (keys[0] !== 'test_decision') {
    throw new Error('Jomini 파서 검증 실패')
  }
  console.log('✅ [Verify] Jomini WASM 파싱 정상 통과!')

  console.log('ℹ️ [Verify] 3. Electron 네이티브 better-sqlite3 + sqlite-vec 바인딩 점검...')
  const electronExe = path.join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  )
  const vecOut = execFileSync(
    electronExe,
    [
      '-e',
      "const Database=require('better-sqlite3'), sv=require('sqlite-vec'); const db=new Database(':memory:'); sv.load(db); console.log(db.prepare('SELECT vec_version() as v').get().v); db.close();"
    ],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  ).trim()
  console.log(`✅ [Verify] sqlite-vec 로드 정상 (${vecOut})`)

  console.log('🎉 [Verify] 모든 핵심 모듈 검증이 성공적으로 완료되었습니다!')
}

runVerification().catch((err: unknown) => {
  console.error('❌ [Verify] 검증 실패:', err)
  process.exit(1)
})
