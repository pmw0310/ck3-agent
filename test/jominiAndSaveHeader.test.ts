import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Jomini } from 'jomini'
import * as R from 'remeda'

describe('Jomini WASM 파서 및 CK3 세이브/모드 전처리 검증', () => {
  it('Jomini WASM이 Clausewitz 결단 및 CK3 1.20 rites 구조를 정상 파싱해야 한다', async () => {
    const parser = await Jomini.initialize()
    const sampleRitesAndDecision = `
      rites={
        database={
          152={
            rite_type=fascist_rite
            faith=42
            data={
              name="국가 조합주의 예법"
            }
          }
        }
      }
      restore_roman_empire_decision={
        major=yes
        cost={ prestige=1000 piety=500 }
      }
    `

    const parsed = parser.parseText(sampleRitesAndDecision) as Record<string, unknown>
    const ritesDb = (
      (parsed.rites as Record<string, unknown>)?.database as Record<string, unknown>
    )?.['152'] as Record<string, unknown>

    assert.equal(ritesDb.faith, 42)
    const decision = parsed.restore_roman_empire_decision as Record<string, unknown>
    assert.equal(decision.major, true)
    assert.deepEqual(decision.cost, { prestige: 1000, piety: 500 })
  })

  it('SAV0102 압축 헤더의 PK 오프셋과 SAV0101 바이너리 철인 헤더를 정확히 구분해야 한다', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck3-hdr-'))
    try {
      const zipSavePath = path.join(tmpDir, 'normal.ck3')
      const preamble = Buffer.from('SAV01026df1fb9d00000018\nmeta_data={\n\tdate=896.2.11\n}\n', 'utf8')
      const fakeZipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
      fs.writeFileSync(zipSavePath, Buffer.concat([preamble, fakeZipHeader]))

      const binSavePath = path.join(tmpDir, 'autosave.ck3')
      const binHeader = Buffer.from('SAV0101a745b4fc0000a5e2\n\x55\x31\x01\x00', 'binary')
      fs.writeFileSync(binSavePath, binHeader)

      const inspectSample = (target: string) => {
        const buf = fs.readFileSync(target)
        const pkOffset = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        const magic = buf.subarray(0, 7).toString('utf8')
        const preview = buf.subarray(0, 120).toString('utf8')
        const isBinaryIronman =
          (magic === 'SAV0101' || magic === 'SAV0103') &&
          pkOffset === -1 &&
          !preview.includes('meta_data={')
        return { pkOffset, isBinaryIronman }
      }

      const normalRes = inspectSample(zipSavePath)
      assert.equal(normalRes.pkOffset, preamble.length)
      assert.equal(normalRes.isBinaryIronman, false)

      const binRes = inspectSample(binSavePath)
      assert.equal(binRes.pkOffset, -1)
      assert.equal(binRes.isBinaryIronman, true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('Remeda R.pipe 기반 VFS 오버라이드 시 후순위 모드가 선순위 파일을 정확히 덮어써야 한다', () => {
    const layers = [
      { relPath: 'common/decisions/00_major.txt', sourceMod: 'Vanilla' },
      { relPath: 'common/traits/00_traits.txt', sourceMod: 'Vanilla' },
      { relPath: 'common/decisions/00_major.txt', sourceMod: 'Community Flavor Pack' },
      { relPath: 'common/decisions/99_villains.txt', sourceMod: 'Reincarnated Villains' }
    ]

    const merged = R.pipe(
      layers,
      R.reduce((acc, item) => {
        acc.set(item.relPath, item)
        return acc
      }, new Map<string, (typeof layers)[number]>()),
      (map) => Array.from(map.values()),
      R.sortBy((item) => item.relPath)
    )

    assert.equal(merged.length, 3)
    assert.equal(merged[0].sourceMod, 'Community Flavor Pack')
    assert.equal(merged[1].sourceMod, 'Reincarnated Villains')
  })
})
