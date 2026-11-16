import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as R from 'remeda'

const ROOT_DIR = process.cwd()

/**
 * 지정 디렉터리 하위의 특정 확장자 파일 경로를 재귀 수집합니다.
 * @param dirPath 탐색 시작 루트 경로
 * @param extensions 허용 확장자 목록
 * @returns 수집된 절대 경로 배열
 */
const collectFiles = (dirPath: string, extensions: string[]): string[] => {
  if (!fs.existsSync(dirPath)) return []
  const results: string[] = []
  const stack = [dirPath]

  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath)
      }
    }
  }

  return results
}

describe('전역 코딩 표준 및 .agents 하네스 무결성 검증', () => {
  it('src/ 및 test/ 하위 모든 TS/TSX 파일은 일반 function 선언문, I-접두사 인터페이스, 명시적 any 타입, 상대 경로 임포트를 포함하지 않아야 한다', () => {
    const sourceFiles = collectFiles(path.join(ROOT_DIR, 'src'), ['.ts', '.tsx'])
    const testFiles = collectFiles(path.join(ROOT_DIR, 'test'), ['.ts', '.tsx'])
    const allTsFiles = [...sourceFiles, ...testFiles]
    assert.ok(sourceFiles.length > 0, '검사할 소스 파일이 존재해야 합니다.')

    const bannedAnyPattern = new RegExp(':\\s*' + 'an' + 'y\\b|\\bas\\s+' + 'an' + 'y\\b|<' + 'an' + 'y>')

    const violations = R.pipe(
      allTsFiles,
      R.flatMap((filePath) => {
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
        const rel = path.relative(ROOT_DIR, filePath)
        const isSrcFile = filePath.startsWith(path.join(ROOT_DIR, 'src'))
        const fileIssues: string[] = []

        lines.forEach((line, idx) => {
          if (/\bfunction\s+[A-Za-z0-9_]*\s*\(/.test(line) || /\bfunction\s*\(/.test(line)) {
            fileIssues.push(`${rel}:${idx + 1} 일반 function 선언 감지`)
          }
          if (/\binterface\s+I[A-Z]/.test(line)) {
            fileIssues.push(`${rel}:${idx + 1} 인터페이스 I 접두사 감지`)
          }
          if (bannedAnyPattern.test(line)) {
            fileIssues.push(`${rel}:${idx + 1} 명시적 any 타입 감지`)
          }
          if (
            isSrcFile &&
            /^\s*import\b/.test(line) &&
            /from\s+['"]\.\.?\//.test(line) &&
            !line.includes('?modulePath')
          ) {
            fileIssues.push(`${rel}:${idx + 1} 별칭 대신 상대 경로 임포트 감지`)
          }
        })
        return fileIssues
      })
    )

    assert.deepEqual(violations, [])
  })

  it('UI 라벨, placeholder, 모델 표시명 및 프리셋/카테고리 명칭에 괄호 부연 설명이 없어야 한다', async () => {
    const { FALLBACK_GEMINI_MODELS, INDEX_TARGET_CATEGORIES, PRESET_PROMPTS } = await import(
      '@shared/constants'
    )

    for (const model of FALLBACK_GEMINI_MODELS) {
      assert.equal(
        /[()]/.test(model.displayName),
        false,
        `모델 displayName에 괄호가 없어야 합니다: ${model.displayName}`
      )
    }

    for (const cat of INDEX_TARGET_CATEGORIES) {
      assert.equal(
        /[()]/.test(cat.labelKo),
        false,
        `카테고리 labelKo에 괄호가 없어야 합니다: ${cat.labelKo}`
      )
    }

    for (const preset of PRESET_PROMPTS) {
      assert.equal(
        /[()]/.test(preset.label),
        false,
        `프리셋 label에 괄호가 없어야 합니다: ${preset.label}`
      )
    }

    const rendererFiles = collectFiles(path.join(ROOT_DIR, 'src', 'renderer'), ['.tsx'])
    const jsxAttrViolations = R.pipe(
      rendererFiles,
      R.flatMap((filePath) => {
        const content = fs.readFileSync(filePath, 'utf8')
        const rel = path.relative(ROOT_DIR, filePath)
        const matches = [
          ...content.matchAll(/\b(?:label|placeholder|title)="([^"]*[()][^"]*)"/g)
        ]
        return matches.map((m) => `${rel}: "${m[1]}"`)
      })
    )

    assert.deepEqual(jsxAttrViolations, [])
  })

  it('package.json 및 .npmrc가 포터블 네이티브 규칙을 준수하고 Tailwind CSS를 포함하지 않아야 한다', () => {
    const npmrc = fs.readFileSync(path.join(ROOT_DIR, '.npmrc'), 'utf8')
    assert.ok(npmrc.includes('node-linker=hoisted'), '.npmrc에 node-linker=hoisted가 필요합니다.')

    const pkgRaw = fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')
    assert.ok(!pkgRaw.toLowerCase().includes('tailwindcss'), 'Tailwind CSS 의존성이 없어야 합니다.')
    assert.ok(!pkgRaw.includes('"@google/generative-ai"'), '구형 Gemini SDK가 없어야 합니다.')
    assert.ok(pkgRaw.includes('"@google/genai"'), '공식 @google/genai SDK가 포함되어야 합니다.')

    for (const tsConfigName of ['tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json']) {
      const tsConfigRaw = JSON.parse(
        fs.readFileSync(path.join(ROOT_DIR, tsConfigName), 'utf8')
      ) as { compilerOptions?: Record<string, unknown> }
      assert.equal(
        tsConfigRaw.compilerOptions?.baseUrl,
        undefined,
        `${tsConfigName}: TypeScript 6.0+ 폐기 옵션인 baseUrl을 사용하지 않고 ./ 접두어 paths만 사용해야 합니다.`
      )
    }
  })

  it('.agents 하위의 모든 SKILL.md 및 rules/*.md 프론트매터가 정상적으로 닫혀 있고 이모지가 없어야 한다', () => {
    const agentsDir = path.join(ROOT_DIR, '.agents')
    if (!fs.existsSync(agentsDir)) {
      return
    }

    const skillFiles = collectFiles(path.join(agentsDir, 'skills'), ['SKILL.md'])
    const ruleFiles = collectFiles(path.join(agentsDir, 'rules'), ['.md'])

    assert.equal(skillFiles.length, 5, '5종의 핵심 스킬 하네스가 등록되어야 합니다.')
    assert.equal(ruleFiles.length, 5, '5종의 도메인 규칙 파일이 등록되어야 합니다.')

    for (const mdPath of [...skillFiles, ...ruleFiles]) {
      const content = fs.readFileSync(mdPath, 'utf8')
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      assert.ok(match, `${path.relative(ROOT_DIR, mdPath)}: YAML 프론트매터가 닫혀 있어야 합니다.`)
      const frontmatter = match[1]
      const hasEmoji = /\p{Extended_Pictographic}/u.test(frontmatter)
      assert.equal(
        hasEmoji,
        false,
        `${path.relative(ROOT_DIR, mdPath)}: YAML 프론트매터 내부에는 이모지가 없어야 합니다.`
      )
    }
  })
})
