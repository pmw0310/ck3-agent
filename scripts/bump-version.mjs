import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const currentFilePath = fileURLToPath(import.meta.url)
const currentDirPath = path.dirname(currentFilePath)
const ROOT_DIR = path.resolve(currentDirPath, '..')

/**
 * Semantic Versioning 2.0 규칙에 따라 버전을 1단계 증가시킵니다.
 * @param {string} currentVersion 현재 버전 문자열 (예: '1.0.0')
 * @param {'major' | 'minor' | 'patch'} bumpType 버전 범프 단위
 * @returns {string} 증가된 새 버전 문자열
 */
const bumpSemanticVersion = (currentVersion, bumpType) => {
  const parts = currentVersion.split('.').map((num) => Number.parseInt(num, 10))
  let major = parts[0] ?? 1
  let minor = parts[1] ?? 0
  let patch = parts[2] ?? 0

  switch (bumpType) {
    case 'major':
      major += 1
      minor = 0
      patch = 0
      break
    case 'minor':
      minor += 1
      patch = 0
      break
    case 'patch':
    default:
      patch += 1
      break
  }

  return `${major}.${minor}.${patch}`
}

/**
 * Conventional Commits 메시지 패턴을 분석하여 범프 단위를 도출합니다.
 * @param {string} commitMessage 커밋 메시지 문자열
 * @returns {'major' | 'minor' | 'patch' | null} 판별된 범프 단위 또는 스킵(null)
 */
const analyzeCommitMessage = (commitMessage) => {
  if (!commitMessage) {
    return 'patch'
  }

  if (
    commitMessage.includes('BREAKING CHANGE') ||
    commitMessage.includes('BREAKING-CHANGE') ||
    /^[a-z]+(\([a-z0-9_,-]+\))?!:/i.test(commitMessage)
  ) {
    return 'major'
  }

  if (/^feat(\([a-z0-9_,-]+\))?:/i.test(commitMessage)) {
    return 'minor'
  }

  if (/^(fix|refactor|perf)(\([a-z0-9_,-]+\))?:/i.test(commitMessage)) {
    return 'patch'
  }

  console.info('ℹ️ [Version] 문서/설정/테스트 커밋으로 판별되어 버전 범프를 건너뜁니다.')
  return null
}

/**
 * 전달 인자 또는 직전 Git 커밋을 기반으로 범프 단위를 결정합니다.
 * @param {string} inputArg 커밋 메시지 또는 단위 ('major' | 'minor' | 'patch' | 'auto')
 * @returns {'major' | 'minor' | 'patch' | null} 범프 단위
 */
const determineBumpType = (inputArg) => {
  if (!inputArg || inputArg === 'auto') {
    try {
      const lastCommitMsg = execSync('git log -1 --pretty=%B', {
        encoding: 'utf-8',
        cwd: ROOT_DIR
      }).trim()
      return analyzeCommitMessage(lastCommitMsg)
    } catch {
      console.warn('⚠️ [Version] 최근 Git 커밋 조회 불가, 기본 patch 단위를 적용합니다.')
      return 'patch'
    }
  }

  const normalized = inputArg.toLowerCase().trim()
  if (normalized === 'major' || normalized === 'minor' || normalized === 'patch') {
    return normalized
  }

  return analyzeCommitMessage(inputArg)
}

/**
 * package.json의 version 필드를 원자적으로 갱신합니다.
 * @param {string} newVersion 새 버전 문자열
 */
const updatePackageJson = (newVersion) => {
  const filePath = path.join(ROOT_DIR, 'package.json')
  if (!fs.existsSync(filePath)) return
  const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  json.version = newVersion
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8')
  console.log(`✅ [Version] package.json 버전 갱신 완료: ${newVersion}`)
}

const hasAnyGitCommits = () => {
  try {
    execSync('git rev-parse --verify HEAD', {
      stdio: 'ignore',
      cwd: ROOT_DIR
    })
    return true
  } catch {
    return false
  }
}

/**
 * 버전 범프 메인 실행 엔트리
 */
const runVersionBump = () => {
  const inputArg = process.argv[2] ?? 'auto'
  const packageJsonPath = path.join(ROOT_DIR, 'package.json')

  if (!fs.existsSync(packageJsonPath)) {
    console.error('❌ [Version] package.json 파일을 찾을 수 없습니다.')
    process.exit(1)
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
  const currentVersion = pkg.version ?? '1.0.0'
  const normalizedArg = inputArg.toLowerCase().trim()

  if (
    !hasAnyGitCommits() &&
    normalizedArg !== 'major' &&
    normalizedArg !== 'minor' &&
    normalizedArg !== 'patch'
  ) {
    console.info(`ℹ️ [Version] 최초 커밋 감지: 초기 버전 ${currentVersion}을 그대로 유지합니다.`)
    process.exit(0)
  }

  const bumpType = determineBumpType(inputArg)

  if (!bumpType) {
    process.exit(0)
  }

  const newVersion = bumpSemanticVersion(currentVersion, bumpType)
  console.info(`ℹ️ [Version] 버전 범프 실행: ${currentVersion} -> ${newVersion} (${bumpType})`)
  updatePackageJson(newVersion)
}

runVersionBump()
