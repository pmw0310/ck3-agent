import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT_DIR = process.cwd()

describe('GitHub Actions 릴리스 워크플로우(release.yml) 수동 및 태그 실행 호환성 검증', () => {
  it('publish-release 잡은 workflow_dispatch 수동 실행 시 건너뛰지(skipped) 않고 package.json 버전 기준 tag_name으로 릴리스를 발행해야 한다', () => {
    const workflowPath = path.join(ROOT_DIR, '.github', 'workflows', 'release.yml')
    const content = fs.readFileSync(workflowPath, 'utf8')

    // 1. workflow_dispatch 실행 시 publish-release 잡이 skipped 되게 만드는 if 조건이 없어야 함
    assert.equal(
      content.includes("if: startsWith(github.ref, 'refs/tags/v')"),
      false,
      'publish-release 잡에 태그 전용 if 가드가 있으면 수동 Run workflow 실행 시 릴리스가 skipped 됩니다.'
    )

    // 2. 브랜치(main)에서 workflow_dispatch 실행 시에도 softprops/action-gh-release가 실패하지 않도록 tag_name 해석 단계가 있어야 함
    assert.ok(
      content.includes('tag_name:'),
      'workflow_dispatch 실행 시에도 릴리스 태그가 지정되도록 tag_name 설정이 포함되어야 합니다.'
    )
  })
})
