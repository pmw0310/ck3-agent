import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { runAdvisorChatTurn } from '@/main/services/agentService'

interface CapturedGeminiRequest {
  url: string
  body: {
    contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>
    tools?: unknown[]
    toolConfig?: {
      functionCallingConfig?: {
        mode?: string
      }
    }
    systemInstruction?: unknown
  }
}

/**
 * 단일 SSE 데이터 프레임을 직렬화합니다.
 * @param payload Gemini GenerateContentResponse 호환 JSON 객체
 * @returns SSE 포맷 문자열
 */
const toSseFrame = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify(payload)}\r\n\r\n`

describe('에이전트 멀티턴 도구 실행 후 빈 본문 종료 결함 재현 검증', () => {
  it('도구 반복 한도에 도달한 뒤에도 tools 스키마와 FunctionCallingConfigMode.NONE으로 최종 본문을 생성해야 한다', async () => {
    const origCwd = process.cwd()
    const origApiKey = process.env.GEMINI_API_KEY
    const origBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck3-agent-repro-max-'))

    const capturedRequests: CapturedGeminiRequest[] = []
    let callIndex = 0

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        callIndex += 1
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const parsedBody = JSON.parse(rawBody) as CapturedGeminiRequest['body']
        capturedRequests.push({ url: req.url || '', body: parsedBody })

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })

        const hasFunctionHistory = Boolean(
          parsedBody.contents?.some((c) =>
            c.parts?.some((p) => 'functionCall' in p || 'functionResponse' in p)
          )
        )
        const hasToolsDeclaration = Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0
        const fcMode = parsedBody.toolConfig?.functionCallingConfig?.mode

        // 실제 Gemini 3 계열 동작 모사:
        // 1) functionCall/functionResponse 이력이 있는데 tools 선언을 누락하면 UNEXPECTED_TOOL_CALL 빈 텍스트 종료
        if (hasFunctionHistory && !hasToolsDeclaration) {
          res.write(
            toSseFrame({
              candidates: [
                {
                  finishReason: 'UNEXPECTED_TOOL_CALL',
                  content: {
                    role: 'model',
                    parts: [{ thought: true, text: 'Attempting another tool without schema...' }]
                  }
                }
              ]
            })
          )
          res.end()
          return
        }

        // 2) 강제 합성 모드(NONE)가 지정된 경우에만 도구 호출을 멈추고 최종 마크다운 전략 보고서를 스트리밍
        if (fcMode === 'NONE') {
          res.write(
            toSseFrame({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: '## 최종 국정 브리핑\n\n' }]
                  }
                }
              ]
            })
          )
          res.write(
            toSseFrame({
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [{ text: '- 직할령 세입과 무장병 편제를 기반으로 즉시 확장이 가능합니다.' }]
                  }
                }
              ]
            })
          )
          res.end()
          return
        }

        // 3) 일반 AUTO 모드에서는 계속 추가 도구를 호출하려는 과잉 탐색 상황 재현
        res.write(
          toSseFrame({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [
                    {
                      thought: true,
                      text: `Checking save step ${callIndex}`,
                      thoughtSignature: `sig-${callIndex}`
                    },
                    {
                      functionCall: {
                        id: `fc-${callIndex}`,
                        name: 'getSaveOverview',
                        args: {}
                      }
                    }
                  ]
                }
              }
            ]
          })
        )
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }

    try {
      process.chdir(tempDir)
      process.env.GEMINI_API_KEY = 'test-dummy-key'
      process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${addr.port}`

      const streamedChunks: string[] = []
      const response = await runAdvisorChatTurn(
        {
          requestId: 'repro-max-iter',
          message: '현재 국정 종합 브리핑 해줘',
          history: []
        },
        () => undefined,
        (ev) => {
          if (ev.deltaText) streamedChunks.push(ev.deltaText)
        }
      )

      assert.notEqual(
        response.reply,
        '도구 조회 결과를 바탕으로 분석을 완료했습니다.',
        '빈 폴백 문구로 끝나지 않고 실제 종합 보고서가 생성되어야 합니다.'
      )
      assert.ok(
        response.reply.includes('최종 국정 브리핑'),
        `최종 합성 본문이 포함되어야 합니다. 실제 응답: ${response.reply}`
      )
      assert.ok(streamedChunks.join('').includes('최종 국정 브리핑'))

      const lastReq = capturedRequests[capturedRequests.length - 1]
      assert.equal(lastReq.body.toolConfig?.functionCallingConfig?.mode, 'NONE')
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

  it('도구 호출 직후 모델이 본문 텍스트 없이 조기 종료(프리앰블만 존재 포함)하면 강제 합성 스트림으로 복구해야 한다', async () => {
    const origCwd = process.cwd()
    const origApiKey = process.env.GEMINI_API_KEY
    const origBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck3-agent-repro-empty-turn-'))

    let callIndex = 0

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        callIndex += 1
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const parsedBody = JSON.parse(rawBody) as CapturedGeminiRequest['body']
        const fcMode = parsedBody.toolConfig?.functionCallingConfig?.mode

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })

        if (callIndex === 1) {
          // 1턴: 짧은 안내 프리앰블 + 도구 호출
          res.write(
            toSseFrame({
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      { text: '세이브 데이터를 먼저 확인하겠습니다.' },
                      {
                        functionCall: {
                          id: 'fc-1',
                          name: 'getSaveOverview',
                          args: {}
                        },
                        thoughtSignature: 'sig-1'
                      }
                    ]
                  }
                }
              ]
            })
          )
          res.end()
          return
        }

        if (callIndex === 2 && fcMode !== 'NONE') {
          // 2턴: 도구 응답 수령 후 사고 파트만 남기고 본문 텍스트 없이 종료되는 비정상 응답 모사
          res.write(
            toSseFrame({
              candidates: [
                {
                  finishReason: 'UNEXPECTED_TOOL_CALL',
                  content: {
                    role: 'model',
                    parts: [{ thought: true, text: 'Internal reasoning cut off...' }]
                  }
                }
              ]
            })
          )
          res.end()
          return
        }

        // 3턴(복구 합성 턴): NONE 모드로 호출 시 정상 보고서 반환
        res.write(
          toSseFrame({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [{ text: '### 상세 진단 결과\n\n금화 및 병력 상태가 안정적입니다.' }]
                }
              }
            ]
          })
        )
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }

    try {
      process.chdir(tempDir)
      process.env.GEMINI_API_KEY = 'test-dummy-key'
      process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${addr.port}`

      const response = await runAdvisorChatTurn(
        {
          requestId: 'repro-empty-turn',
          message: '내 재정과 병력 진단해줘',
          history: []
        },
        () => undefined
      )

      assert.ok(
        response.reply.includes('상세 진단 결과'),
        `프리앰블만 남기고 끊기지 않고 복구 합성 본문이 포함되어야 합니다. 실제 응답: ${response.reply}`
      )
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
