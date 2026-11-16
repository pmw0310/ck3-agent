import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { runAdvisorChatTurn } from '@/main/services/agentService'
import {
  deleteChatSession,
  listChatSessions,
  saveChatSession
} from '@/main/services/chatSessionService'
import type { ChatSession } from '@shared/types'

interface FunctionDeclShape {
  name: string
}

interface CapturedModeRequest {
  tools?: Array<{ functionDeclarations?: FunctionDeclShape[] }>
  contents?: Array<{ parts?: Array<{ text?: string }> }>
  systemInstruction?: { parts?: Array<{ text?: string }> } | string
}

const toSseFrame = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify(payload)}\r\n\r\n`

describe('세이브 판세 분석 vs 일반 현인 모드 도구 격리 및 채팅 세션 분화 검증', () => {
  it('일반 질문(general_advisor) 모드에서는 세이브 조회 도구 4종이 완전히 제외되고 스크립트 및 과거 대화 참조 도구만 노출되어야 한다', async () => {
    const origCwd = process.cwd()
    const origApiKey = process.env.GEMINI_API_KEY
    const origBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck3-agent-mode-test-'))

    const capturedBodies: CapturedModeRequest[] = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedModeRequest
        capturedBodies.push(parsed)

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        res.write(
          toSseFrame({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [{ text: '**근면함**과 **야심가**는 모두 최상급 1티어 성격 트레잇입니다.' }]
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

      await runAdvisorChatTurn(
        {
          requestId: 'general-mode-1',
          message: '근면함이랑 야심가 중 어떤 성격이 더 좋아?',
          history: [],
          mode: 'general_advisor'
        },
        () => undefined
      )

      await runAdvisorChatTurn(
        {
          requestId: 'save-mode-1',
          message: '현재 내 군주 상황 브리핑해줘',
          history: [],
          mode: 'save_analysis'
        },
        () => undefined
      )

      assert.equal(capturedBodies.length, 2)

      const generalDeclNames = (
        capturedBodies[0].tools?.[0]?.functionDeclarations ?? []
      ).map((d) => d.name)
      assert.deepEqual(generalDeclNames, [
        'searchGameScriptsSemantic',
        'getGameScriptByKey',
        'lookupLocalization',
        'recallPastConversations'
      ])

      const saveDeclNames = (
        capturedBodies[1].tools?.[0]?.functionDeclarations ?? []
      ).map((d) => d.name)
      assert.equal(saveDeclNames.length, 8)
      assert.ok(saveDeclNames.includes('getSaveOverview'))
      assert.ok(saveDeclNames.includes('queryCharacters'))
      assert.ok(saveDeclNames.includes('recallPastConversations'))

      // 사용자 턴 메시지에는 시스템 브리핑 헤더가 섞이지 않고 순수 발화만 들어가야 한다
      const pureUserMsg = capturedBodies[0].contents?.[0]?.parts?.[0]?.text
      assert.equal(pureUserMsg, '근면함이랑 야심가 중 어떤 성격이 더 좋아?')
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

  it('포터블 ./data/chat_sessions.json에 다중 채팅 세션 생성, 분기(parentSessionId), 수정 및 삭제가 정상 동작해야 한다', () => {
    const origCwd = process.cwd()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck3-agent-sessions-test-'))

    try {
      process.chdir(tempDir)
      assert.deepEqual(listChatSessions(), [])

      const firstSession: ChatSession = {
        id: 'sess-1',
        title: '트레잇 비교 질문',
        mode: 'general_advisor',
        createdAt: '2026-11-16T01:00:00.000Z',
        updatedAt: '2026-11-16T01:00:00.000Z',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: '야심가 vs 근면함',
            createdAt: '2026-11-16T01:00:00.000Z',
            modeUsed: 'general_advisor'
          }
        ]
      }

      const branchedSession: ChatSession = {
        id: 'sess-2',
        title: '[분기] 베니토 국정 진단',
        mode: 'save_analysis',
        parentSessionId: 'sess-1',
        saveContextLabel: '두체 베니토 · 896.2.11년',
        createdAt: '2026-11-16T02:00:00.000Z',
        updatedAt: '2026-11-16T02:00:00.000Z',
        messages: [...firstSession.messages]
      }

      saveChatSession(firstSession)
      const afterSecond = saveChatSession(branchedSession)
      assert.equal(afterSecond.length, 2)
      assert.equal(afterSecond[0].id, 'sess-2', '최신 업데이트 세션이 상단에 정렬되어야 합니다.')
      assert.equal(afterSecond[0].parentSessionId, 'sess-1')

      const afterDelete = deleteChatSession('sess-1')
      assert.equal(afterDelete.length, 1)
      assert.equal(afterDelete[0].id, 'sess-2')
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('다른 채팅방에서 나눈 대화 내용이 현재 대화의 시스템 맥락에 자동 공유되고 recallPastConversations 도구로 정밀 조회되어야 한다', async () => {
    const origCwd = process.cwd()
    const origApiKey = process.env.GEMINI_API_KEY
    const origBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck3-agent-cross-memory-'))

    const capturedBodies: CapturedModeRequest[] = []
    let turnNum = 0

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        turnNum += 1
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedModeRequest
        capturedBodies.push(parsed)

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })

        if (turnNum === 1) {
          res.write(
            toSseFrame({
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          id: 'fc-mem-1',
                          name: 'recallPastConversations',
                          args: { query: '카타프락토이' }
                        },
                        thoughtSignature: 'sig-mem-1'
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

        res.write(
          toSseFrame({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [
                    {
                      text: '앞서 다른 대화에서 말씀하신 카타프락토이 중기병 편제 방향에 맞춰 주둔지 마구간부터 올리시면 됩니다.'
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

      saveChatSession({
        id: 'past-chat-maa',
        title: '동로마 무장병 구상',
        mode: 'general_advisor',
        createdAt: '2026-11-16T01:00:00.000Z',
        updatedAt: '2026-11-16T01:05:00.000Z',
        messages: [
          {
            id: 'pm-1',
            role: 'user',
            content: '이번 판은 카타프락토이 중기병 올인 빌드로 가려고 해',
            createdAt: '2026-11-16T01:00:00.000Z'
          },
          {
            id: 'pm-2',
            role: 'assistant',
            content: '카타프락토이 중기병을 주력으로 쓰신다면 평야 주둔지 마구간과 대장간 시너지가 핵심입니다.',
            createdAt: '2026-11-16T01:01:00.000Z'
          }
        ]
      })

      const res = await runAdvisorChatTurn(
        {
          requestId: 'cross-mem-req',
          sessionId: 'new-save-chat',
          mode: 'save_analysis',
          message: '아까 다른 대화에서 정한 병종 기준으로 내 직할령 건물 어떻게 지을까?',
          history: []
        },
        () => undefined
      )

      const sysText = JSON.stringify(capturedBodies[0].systemInstruction ?? '')
      assert.ok(
        sysText.includes('동로마 무장병 구상') && sysText.includes('카타프락토이'),
        '시스템 브리핑에 다른 채팅방의 최근 대화 맥락이 자동으로 주입되어야 합니다.'
      )
      assert.equal(res.toolSteps[0]?.toolName, 'recallPastConversations')
      assert.ok(res.reply.includes('카타프락토이'))
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
