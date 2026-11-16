import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

describe('Electron 런타임 내 better-sqlite3 및 sqlite-vec 통합 검증', () => {
  it('Electron ABI 환경에서 sqlite-vec vec0 가상 테이블 생성 및 L2 최근접 이웃 검색이 동작해야 한다', () => {
    const electronExe = path.join(
      process.cwd(),
      'node_modules',
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron'
    )

    const inlineScript = `
      const Database = require('better-sqlite3');
      const sqliteVec = require('sqlite-vec');
      const db = new Database(':memory:');
      sqliteVec.load(db);
      db.exec('CREATE VIRTUAL TABLE test_vec USING vec0(embedding float[4])');
      const stmt = db.prepare('INSERT INTO test_vec (rowid, embedding) VALUES (?, ?)');
      stmt.run(1n, Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));
      stmt.run(2n, Buffer.from(new Float32Array([0, 1, 0, 0]).buffer));
      const query = Buffer.from(new Float32Array([0.9, 0.1, 0, 0]).buffer);
      const top = db.prepare('SELECT rowid, vec_distance_l2(embedding, ?) AS d FROM test_vec ORDER BY d ASC LIMIT 1').get(query);
      console.log(JSON.stringify({ rowid: Number(top.rowid), vecVersion: db.prepare('SELECT vec_version() as v').get().v }));
      db.close();
    `

    const stdout = execFileSync(electronExe, ['-e', inlineScript], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }).trim()

    const parsed = JSON.parse(stdout) as { rowid: number; vecVersion: string }
    assert.equal(parsed.rowid, 1)
    assert.ok(parsed.vecVersion.startsWith('v0.'), 'sqlite-vec 버전 문자열이 반환되어야 합니다.')
  })
})
