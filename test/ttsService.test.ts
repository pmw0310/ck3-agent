import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { sanitizeMarkdownForSpeech, splitTextIntoSpeechChunks } from '@shared/ttsTextUtils'
import { buildEdgeTtsSynthUrlV2, generateSecMsGecV2 } from '@/main/services/edgeTtsDrm'
import { synthesizeAdvisorSpeech, wrapPcmWithWavHeader } from '@/main/services/ttsService'

describe('무료 Edge TTS DRM 및 제미나이 TTS 음성 합성 파이프라인 검증', () => {
  it('마크다운 답변에서 코드블록·기호·표 구분선을 정제하고 문장 청크로 분할해야 한다', () => {
    const sampleMd = [
      '### 핵심 국정 진단',
      '- **금화 보유량**: `1,250` 골드로 안정적입니다.',
      '| 항목 | 수치 |',
      '| --- | --- |',
      '| 병력 | 8,400명 |',
      '```txt',
      'is_shown = { has_trait = ambitious }',
      '```',
      '따라서 당장 성전을 선포하셔도 좋습니다!'
    ].join('\n')

    const clean = sanitizeMarkdownForSpeech(sampleMd)
    assert.equal(clean.includes('```'), false)
    assert.equal(clean.includes('is_shown'), false)
    assert.equal(clean.includes('###'), false)
    assert.equal(clean.includes('**'), false)
    assert.ok(clean.includes('핵심 국정 진단.'))
    assert.ok(clean.includes('따라서 당장 성전을 선포하셔도 좋습니다!'))

    const longText = Array.from({ length: 12 }, (_, idx) => `${idx + 1}번째 전략 조언 문장입니다.`).join(' ')
    const chunks = splitTextIntoSpeechChunks(longText, 80)
    assert.ok(chunks.length >= 2)
    assert.ok(chunks.every((c) => c.length <= 80))
  })

  it('Edge TTS용 Sec-MS-GEC v2 토큰 규격 및 WSS 합성 URL이 정확히 생성되어야 한다', () => {
    const token = generateSecMsGecV2(1735689600)
    assert.match(token, /^[0-9A-F]{16}-[0-9A-F]{64}$/)

    const wssUrl = buildEdgeTtsSynthUrlV2(1735689600)
    assert.ok(wssUrl.includes('Sec-MS-GEC-Version=2-143.0.3650.75'))
    assert.ok(wssUrl.includes(`Sec-MS-GEC=${token}`))
  })

  it('제미나이 TTS의 24kHz PCM 응답을 RIFF WAV로 래핑하고 로컬 포터블 캐시에서 재사용해야 한다', async () => {
    const pcmSample = Buffer.alloc(480, 0x11)
    const wavBuf = wrapPcmWithWavHeader(pcmSample, 24000)
    assert.equal(wavBuf.length, 44 + 480)
    assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(wavBuf.subarray(8, 12).toString('ascii'), 'WAVE')
    assert.equal(wavBuf.readUInt32LE(24), 24000)

    const origCwd = process.cwd()
    const origApiKey = process.env.GEMINI_API_KEY
    const origBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck3-agent-tts-test-'))

    let apiHitCount = 0
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        apiHitCount += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/L16;codec=pcm;rate=24000',
                        data: pcmSample.toString('base64')
                      }
                    }
                  ]
                }
              }
            ]
          })
        )
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }

    try {
      process.chdir(tempDir)
      process.env.GEMINI_API_KEY = 'test-tts-key'
      process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${addr.port}`

      const first = await synthesizeAdvisorSpeech({
        text: '**폐하**, 직할령 금화가 충분합니다.',
        providerOverride: 'gemini',
        geminiModelOverride: 'gemini-3.8-flash-tts',
        geminiVoiceOverride: 'Charon'
      })

      assert.equal(first.success, true)
      assert.equal(first.mimeType, 'audio/wav')
      assert.ok(first.audioBase64)
      assert.equal(Buffer.from(first.audioBase64, 'base64').subarray(0, 4).toString('ascii'), 'RIFF')
      assert.equal(apiHitCount, 1)

      // 동일 문장 2회차 요청 시 API 호출 없이 ./data/tts_cache 히트 검증
      const second = await synthesizeAdvisorSpeech({
        text: '**폐하**, 직할령 금화가 충분합니다.',
        providerOverride: 'gemini',
        geminiModelOverride: 'gemini-3.8-flash-tts',
        geminiVoiceOverride: 'Charon'
      })
      assert.equal(second.success, true)
      assert.equal(apiHitCount, 1, '포터블 로컬 캐시 적중으로 추가 API 호출이 없어야 합니다.')
    } finally {
      process.chdir(origCwd)
      if (origApiKey === undefined) delete process.env.GEMINI_API_KEY
      else process.env.GEMINI_API_KEY = origApiKey
      if (origBaseUrl === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL
      else process.env.GOOGLE_GEMINI_BASE_URL = origBaseUrl
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
