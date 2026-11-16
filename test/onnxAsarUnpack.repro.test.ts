import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT_DIR = process.cwd()

describe('패키징 환경(app.asar.unpacked)에서 외부 모듈 전이 의존성 해석 무결성 검증', () => {
  it('pnpm-workspace.yaml에 nodeLinker: hoisted가 명시되고, asarUnpack 대상 외부 모듈의 필수 런타임 전이 의존성이 최상위 node_modules 및 asarUnpack에 모두 포함되어야 한다', () => {
    const workspaceYaml = fs.readFileSync(path.join(ROOT_DIR, 'pnpm-workspace.yaml'), 'utf8')
    assert.ok(
      workspaceYaml.includes('nodeLinker: hoisted'),
      'pnpm v11/v12+ 호환을 위해 pnpm-workspace.yaml에 nodeLinker: hoisted가 반드시 선언되어야 합니다.'
    )

    const builderYml = fs.readFileSync(path.join(ROOT_DIR, 'electron-builder.yml'), 'utf8')

    // Worker Thread(app.asar.unpacked)에서 require()될 때 app.asar 내부를 볼 수 없으므로
    // onnxruntime-node, @huggingface/transformers, better-sqlite3, msedge-tts의 전이 의존성이
    // 최상위 node_modules에 호이스팅되어 있고 asarUnpack에도 등록되어 있어야 한다.
    const requiredRuntimePackages = [
      'onnxruntime-common',
      'onnxruntime-node',
      'onnxruntime-web',
      '@huggingface/transformers',
      '@huggingface/jinja',
      'sharp',
      'better-sqlite3',
      'bindings',
      'file-uri-to-path',
      'sqlite-vec',
      'jomini',
      'node-stream-zip',
      'msedge-tts',
      'ws',
      'isomorphic-ws'
    ]

    for (const pkgName of requiredRuntimePackages) {
      const hoistedPkgPath = path.join(ROOT_DIR, 'node_modules', pkgName, 'package.json')
      assert.equal(
        fs.existsSync(hoistedPkgPath),
        true,
        `최상위 node_modules에 ${pkgName}이(가) 호이스팅되어 있어야 합니다.`
      )
      const isCoveredByUnpack =
        builderYml.includes('node_modules/**') ||
        builderYml.includes(`node_modules/${pkgName}/**`)
      assert.equal(
        isCoveredByUnpack,
        true,
        `electron-builder.yml의 asarUnpack에 ${pkgName}이(가) 포함되어야 합니다.`
      )
    }
  })
})
