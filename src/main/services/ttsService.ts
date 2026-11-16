import crypto from 'node:crypto'
import dns from 'node:dns'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { GoogleGenAI } from '@google/genai'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import * as R from 'remeda'
import {
  DEFAULT_EDGE_TTS_RATE,
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE
} from '@shared/constants'
import { sanitizeMarkdownForSpeech } from '@shared/ttsTextUtils'
import type {
  EdgeTtsVoice,
  GeminiTtsModel,
  GeminiTtsVoice,
  TtsProvider,
  TtsSynthesizePayload,
  TtsSynthesizeResult
} from '@shared/types'
import {
  getTtsCacheDir,
  loadAppConfig,
  loadGeminiApiKey,
  sanitizeSensitiveText
} from '@/main/services/configService'
import { applyEdgeTtsDrmPatch, guardEdgeTtsInstance } from '@/main/services/edgeTtsDrm'

const MAX_CACHED_GEMINI_CLIPS = 80
const dnsCache = new Map<string, { addresses: string[]; expiresAt: number }>()

const clearEdgeTtsDnsCache = (hostname?: string): void => {
  if (hostname) {
    dnsCache.delete(hostname)
  } else {
    dnsCache.clear()
  }
}

const edgeTtsDnsLookup = (
  hostname: string,
  options: unknown,
  callback?: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number
  ) => void
): void => {
  const actualCallback =
    typeof options === 'function'
      ? (options as (
          err: NodeJS.ErrnoException | null,
          address: string | { address: string; family: number }[],
          family?: number
        ) => void)
      : callback
  const actualOptions = typeof options === 'object' && options !== null ? options : {}

  if (!actualCallback) return

  const isAll = 'all' in actualOptions && Boolean((actualOptions as { all?: boolean }).all)
  const now = Date.now()
  const cached = dnsCache.get(hostname)

  if (cached && cached.expiresAt > now) {
    if (isAll) {
      actualCallback(
        null,
        cached.addresses.map((addr) => ({ address: addr, family: 4 }))
      )
    } else {
      actualCallback(null, cached.addresses[0], 4)
    }
    return
  }

  dns.resolve4(hostname, (resolveErr, addresses) => {
    if (!resolveErr && addresses && addresses.length > 0) {
      dnsCache.set(hostname, { addresses, expiresAt: now + 10 * 60 * 1000 })
      if (isAll) {
        actualCallback(
          null,
          addresses.map((addr) => ({ address: addr, family: 4 }))
        )
      } else {
        actualCallback(null, addresses[0], 4)
      }
      return
    }
    dns.lookup(hostname, actualOptions, actualCallback)
  })
}

const edgeTtsAgent = new https.Agent({
  keepAlive: true,
  lookup: edgeTtsDnsLookup
})

applyEdgeTtsDrmPatch(MsEdgeTTS, edgeTtsAgent)

/**
 * 24kHz 16비트 모노 PCM 바이트 배열 앞에 44바이트 표준 RIFF WAV 헤더를 부착합니다.
 * @param pcmData 원본 PCM 버퍼
 * @param sampleRate 샘플 레이트
 * @returns 브라우저 재생 가능한 WAV 버퍼
 */
export const wrapPcmWithWavHeader = (pcmData: Buffer, sampleRate = 24000): Buffer => {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = pcmData.length
  const header = Buffer.alloc(44)

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcmData])
}

const buildGeminiCachePath = (model: string, voice: string, text: string): string => {
  const hash = crypto
    .createHash('sha256')
    .update(`gemini|${model}|${voice}|${text}`)
    .digest('hex')
  return path.join(getTtsCacheDir(), `${hash}.json`)
}

const readCachedGeminiAudio = async (
  cachePath: string
): Promise<{ audioBase64: string; mimeType: string } | null> => {
  try {
    const raw = await fs.promises.readFile(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as {
      audioBase64?: string
      mimeType?: string
    }
    if (parsed.audioBase64 && parsed.mimeType) {
      return { audioBase64: parsed.audioBase64, mimeType: parsed.mimeType }
    }
    return null
  } catch {
    return null
  }
}

const writeCachedGeminiAudio = async (
  cachePath: string,
  audio: { audioBase64: string; mimeType: string }
): Promise<void> => {
  try {
    const dir = getTtsCacheDir()
    const tempPath = `${cachePath}.${crypto.randomUUID()}.tmp`
    await fs.promises.writeFile(tempPath, JSON.stringify(audio), 'utf8')
    await fs.promises.rename(tempPath, cachePath)

    void (async () => {
      try {
        const jsonNames = (await fs.promises.readdir(dir)).filter((name) => name.endsWith('.json'))
        if (jsonNames.length <= MAX_CACHED_GEMINI_CLIPS) {
          return
        }

        const statsList = await Promise.all(
          jsonNames.map(async (name) => {
            const full = path.join(dir, name)
            const stat = await fs.promises.stat(full)
            return { full, mtimeMs: stat.mtimeMs }
          })
        )

        const sorted = R.sortBy(statsList, [(item) => item.mtimeMs, 'desc'])
        await Promise.all(
          sorted.slice(MAX_CACHED_GEMINI_CLIPS).map((stale) =>
            fs.promises.unlink(stale.full).catch(() => undefined)
          )
        )
      } catch {
        // 백그라운드 캐시 정리 실패 무시
      }
    })()
  } catch {
    // 캐시 저장 실패 무시
  }
}

/**
 * 무료 Microsoft Edge 신경망 TTS로 한국어 음성을 합성합니다.
 */
export const synthesizeWithFreeEdgeTts = async (params: {
  text: string
  voice: EdgeTtsVoice
  rate: string
  timeoutMs?: number
}): Promise<{ audioBase64: string; mimeType: string }> => {
  applyEdgeTtsDrmPatch(MsEdgeTTS, edgeTtsAgent)
  const timeoutMs = params.timeoutMs ?? 15000
  const tts = new MsEdgeTTS({ agent: edgeTtsAgent })
  guardEdgeTtsInstance(tts)

  return await new Promise<{ audioBase64: string; mimeType: string }>((resolve, reject) => {
    let isSettled = false
    let readableStream: { destroy?: () => void } | null = null

    const cleanup = (): void => {
      clearTimeout(timeoutTimer)
      try {
        tts.close()
      } catch {
        // 소켓 닫기 예외 무시
      }
    }

    const timeoutTimer = setTimeout(() => {
      if (isSettled) return
      isSettled = true
      cleanup()
      try {
        readableStream?.destroy?.()
      } catch {
        // 스트림 해제 무시
      }
      reject(new Error('무료 음성 합성 응답 시간이 초과되었습니다.'))
    }, timeoutMs)

    void (async () => {
      try {
        await tts.setMetadata(params.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
        if (isSettled) return

        const streamResult = tts.toStream(params.text, {
          rate: params.rate || DEFAULT_EDGE_TTS_RATE,
          volume: '+0%'
        })

        const readable = streamResult.audioStream
        readableStream = readable
        const chunks: Buffer[] = []

        readable.on('data', (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk)
          }
        })

        readable.on('end', () => {
          if (isSettled) return
          isSettled = true
          cleanup()
          const fullBuffer = Buffer.concat(chunks)
          if (fullBuffer.length === 0) {
            reject(new Error('무료 음성 서버에서 빈 오디오가 반환되었습니다.'))
            return
          }
          resolve({
            audioBase64: fullBuffer.toString('base64'),
            mimeType: 'audio/mp3'
          })
        })

        readable.on('error', (err: unknown) => {
          if (isSettled) return
          isSettled = true
          cleanup()
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('ENOTFOUND') || msg.includes('speech.platform.bing.com')) {
            clearEdgeTtsDnsCache('speech.platform.bing.com')
          }
          reject(new Error(`무료 음성 합성 실패: ${msg}`))
        })
      } catch (err: unknown) {
        if (isSettled) return
        isSettled = true
        cleanup()
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('ENOTFOUND') || msg.includes('speech.platform.bing.com')) {
          clearEdgeTtsDnsCache('speech.platform.bing.com')
        }
        reject(new Error(`무료 음성 합성 실패: ${msg}`))
      }
    })()
  })
}

/**
 * Google Gemini 전용 TTS 모델로 자연스러운 음성을 합성하고 `./data/tts_cache`에 캐싱합니다.
 */
export const synthesizeWithGeminiTts = async (params: {
  text: string
  apiKey: string
  model: GeminiTtsModel
  voice: GeminiTtsVoice
}): Promise<{ audioBase64: string; mimeType: string }> => {
  const cachePath = buildGeminiCachePath(params.model, params.voice, params.text)
  const cached = await readCachedGeminiAudio(cachePath)
  if (cached) {
    return cached
  }

  const ai = new GoogleGenAI({ apiKey: params.apiKey })
  const directedText = `[calm and measured] ${params.text.trim()}`

  const requestWithModel = async (targetModel: string, inputText: string) =>
    ai.models.generateContent({
      model: targetModel,
      contents: [{ role: 'user', parts: [{ text: inputText }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: params.voice
            }
          }
        }
      }
    })

  let response
  try {
    response = await requestWithModel(params.model, directedText)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    if (
      params.model === 'gemini-3.8-flash-lite-tts' &&
      (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED'))
    ) {
      response = await requestWithModel('gemini-3.8-flash-tts', directedText)
    } else if (errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('NOT_FOUND')) {
      response = await requestWithModel('gemini-2.5-flash-preview-tts', params.text.trim())
    } else if (errMsg.includes('tag') || errMsg.includes('Developer instruction')) {
      response = await requestWithModel(params.model, params.text.trim())
    } else {
      throw err
    }
  }

  const audioPart = response.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part.inlineData?.data === 'string'
  )

  const base64Data = audioPart?.inlineData?.data
  const mimeType = audioPart?.inlineData?.mimeType ?? 'audio/wav'

  if (!base64Data) {
    throw new Error('제미나이 TTS로부터 오디오 데이터가 반환되지 않았습니다.')
  }

  const rawBuffer = Buffer.from(base64Data, 'base64')
  const finalAudio = mimeType.toLowerCase().includes('pcm')
    ? {
        audioBase64: wrapPcmWithWavHeader(rawBuffer, 24000).toString('base64'),
        mimeType: 'audio/wav'
      }
    : {
        audioBase64: base64Data,
        mimeType
      }

  await writeCachedGeminiAudio(cachePath, finalAudio)
  return finalAudio
}

/**
 * 선택된 TTS 제공자(무료 Edge 또는 제미나이 TTS)로 텍스트 청크를 합성합니다.
 * 제미나이 TTS 실패 시 무료 Edge TTS로 자동 폴백하여 음성 끊김을 방지합니다.
 */
export const synthesizeAdvisorSpeech = async (
  payload: TtsSynthesizePayload
): Promise<TtsSynthesizeResult> => {
  const cleanText = sanitizeMarkdownForSpeech(payload.text)
  if (!cleanText) {
    return {
      success: false,
      error: '낭독할 텍스트가 없습니다.'
    }
  }

  const config = loadAppConfig()
  const provider: TtsProvider = payload.providerOverride ?? config.ttsProvider ?? 'edge'
  const edgeVoice: EdgeTtsVoice =
    payload.edgeVoiceOverride ?? config.edgeTtsVoice ?? DEFAULT_EDGE_TTS_VOICE
  const edgeRate = payload.edgeRateOverride ?? config.edgeTtsRate ?? DEFAULT_EDGE_TTS_RATE
  const geminiModel: GeminiTtsModel =
    payload.geminiModelOverride ?? config.geminiTtsModel ?? DEFAULT_GEMINI_TTS_MODEL
  const geminiVoice: GeminiTtsVoice =
    payload.geminiVoiceOverride ?? config.geminiTtsVoice ?? DEFAULT_GEMINI_TTS_VOICE

  if (provider === 'gemini') {
    const apiKey = loadGeminiApiKey()
    if (!apiKey) {
      try {
        const fallbackAudio = await synthesizeWithFreeEdgeTts({
          text: cleanText,
          voice: edgeVoice,
          rate: edgeRate
        })
        return {
          success: true,
          ...fallbackAudio,
          usedFallback: true,
          fallbackReason: 'Gemini API 키가 없어 무료 음성으로 재생합니다.'
        }
      } catch (edgeErr) {
        const msg = edgeErr instanceof Error ? edgeErr.message : String(edgeErr)
        return { success: false, error: msg }
      }
    }

    try {
      const geminiAudio = await synthesizeWithGeminiTts({
        text: cleanText,
        apiKey,
        model: geminiModel,
        voice: geminiVoice
      })
      return {
        success: true,
        ...geminiAudio
      }
    } catch (geminiErr) {
      const maskedReason = sanitizeSensitiveText(
        geminiErr instanceof Error ? geminiErr.message : String(geminiErr),
        apiKey
      )
      console.warn('⚠️ [TTS] 제미나이 TTS 오류로 무료 Edge 음성 폴백 실행:', maskedReason)
      try {
        const fallbackAudio = await synthesizeWithFreeEdgeTts({
          text: cleanText,
          voice: edgeVoice,
          rate: edgeRate
        })
        return {
          success: true,
          ...fallbackAudio,
          usedFallback: true,
          fallbackReason: '제미나이 TTS 응답 지연 또는 한도 초과로 무료 음성으로 전환되었습니다.'
        }
      } catch {
        return {
          success: false,
          error: `제미나이 음성 합성 실패: ${maskedReason}`
        }
      }
    }
  }

  try {
    const edgeAudio = await synthesizeWithFreeEdgeTts({
      text: cleanText,
      voice: edgeVoice,
      rate: edgeRate
    })
    return {
      success: true,
      ...edgeAudio
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: msg
    }
  }
}
