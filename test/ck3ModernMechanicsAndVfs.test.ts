import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ADVISOR_SYSTEM_PROMPT,
  CK3_MODERN_MECHANICS_GUARDRAILS,
  GENERAL_ADVISOR_SYSTEM_PROMPT,
  INDEX_TARGET_CATEGORIES
} from '@shared/constants'

describe('CK3 1.20+ 메카닉 가드레일(관리력 vs 직할령 한계) 및 VFS 카테고리 정합성 검증', () => {
  it('시스템 프롬프트에 관리력이 직할령 한계를 올리지 않고 교육/인생관 특전으로만 오른다는 현행 패치 규칙이 포함되어야 한다', () => {
    assert.ok(
      CK3_MODERN_MECHANICS_GUARDRAILS.includes('STEWARDSHIP_SKILL_FOR_DOMAIN_LIMIT_INCREASE = 200'),
      '엔진 상수 근거(STEWARDSHIP_SKILL_FOR_DOMAIN_LIMIT_INCREASE = 200)가 명시되어야 합니다.'
    )
    assert.ok(
      ADVISOR_SYSTEM_PROMPT.includes('관리력이 올라 직할령 상한 확보에 보탬이 된다'),
      '세이브 분석 프롬프트에 관리력→직할령 상한 오답 금지 지침이 포함되어야 합니다.'
    )
    assert.ok(
      GENERAL_ADVISOR_SYSTEM_PROMPT.includes('교육 특성 등급') &&
        GENERAL_ADVISOR_SYSTEM_PROMPT.includes('분할 주의'),
      '일반 현인 프롬프트에 교육 특성 및 인생관 특전 기반 직할령 상한 규칙이 포함되어야 합니다.'
    )
  })

  it('INDEX_TARGET_CATEGORIES의 특전·교리·봉신계약·모략·변동치·상수 경로가 CK3 1.20 실제 폴더 구조와 일치해야 한다', () => {
    const byCat = new Map(INDEX_TARGET_CATEGORIES.map((c) => [c.category, c.relDir]))

    assert.equal(byCat.get('perks'), 'common/lifestyle_perks')
    assert.equal(byCat.get('religion_doctrines'), 'common/religion/doctrine_types')
    assert.equal(byCat.get('religion_tenets'), 'common/religion/tenet_types')
    assert.equal(byCat.get('vassal_contracts'), 'common/subject_contracts/contracts')
    assert.equal(byCat.get('schemes'), 'common/schemes/scheme_types')
    assert.equal(byCat.get('modifiers'), 'common/modifiers')
    assert.equal(byCat.get('defines'), 'common/defines')

    const vanillaGameCommon =
      'C:/Program Files (x86)/Steam/steamapps/common/Crusader Kings III/game'
    if (fs.existsSync(vanillaGameCommon)) {
      for (const item of INDEX_TARGET_CATEGORIES) {
        const fullDir = path.join(vanillaGameCommon, item.relDir)
        assert.equal(
          fs.existsSync(fullDir),
          true,
          `실제 CK3 설치 경로에 ${item.relDir} 폴더가 존재해야 합니다.`
        )
      }
    }
  })
})
