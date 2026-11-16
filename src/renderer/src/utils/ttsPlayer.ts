import { splitTextIntoSpeechChunks } from '@shared/ttsTextUtils'
import type { TtsSynthesizePayload, TtsSynthesizeResult } from '@shared/types'

export type TtsPlaybackStatus = 'idle' | 'loading' | 'playing'

export interface TtsPlaybackSnapshot {
  status: TtsPlaybackStatus
  activeId: string | null
}

type TtsListener = (snapshot: TtsPlaybackSnapshot) => void

let currentSnapshot: TtsPlaybackSnapshot = {
  status: 'idle',
  activeId: null
}

let activeToken = 0
let currentAudio: HTMLAudioElement | null = null
const listeners = new Set<TtsListener>()

const emitSnapshot = (next: TtsPlaybackSnapshot): void => {
  currentSnapshot = next
  for (const listener of listeners) {
    listener(currentSnapshot)
  }
}

export const getTtsPlaybackSnapshot = (): TtsPlaybackSnapshot => currentSnapshot

export const subscribeTtsPlayback = (listener: TtsListener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 현재 진행 중인 모든 TTS 합성 대기열과 오디오 재생을 즉시 정지합니다.
 */
export const stopTtsPlayback = (): void => {
  activeToken += 1
  if (currentAudio) {
    try {
      currentAudio.onended = null
      currentAudio.onerror = null
      currentAudio.pause()
      currentAudio.src = ''
    } catch {
      // 오디오 정리 무시
    }
    currentAudio = null
  }
  if (currentSnapshot.status !== 'idle' || currentSnapshot.activeId !== null) {
    emitSnapshot({ status: 'idle', activeId: null })
  }
}

const playSingleBase64Audio = (
  audioBase64: string,
  mimeType: string,
  token: number
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (token !== activeToken) {
      resolve()
      return
    }

    const audio = new Audio(`data:${mimeType};base64,${audioBase64}`)
    currentAudio = audio

    audio.onended = () => {
      if (currentAudio === audio) {
        currentAudio = null
      }
      resolve()
    }

    audio.onerror = () => {
      if (currentAudio === audio) {
        currentAudio = null
      }
      reject(new Error('오디오 스트림 디코딩 또는 출력에 실패했습니다.'))
    }

    audio.play().catch((err) => {
      if (currentAudio === audio) {
        currentAudio = null
      }
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })

/**
 * 마크다운 텍스트를 문장 단위로 분할하여 첫 청크 재생과 동시에 다음 청크를 선행 합성하며 끊김 없이 낭독합니다.
 */
export const playTtsForText = async (params: {
  id: string
  markdownText: string
  overrides?: Omit<TtsSynthesizePayload, 'text'>
  onFallbackNotice?: (reason: string) => void
  onError?: (errorMsg: string) => void
}): Promise<void> => {
  if (currentSnapshot.activeId === params.id && currentSnapshot.status !== 'idle') {
    stopTtsPlayback()
    return
  }

  stopTtsPlayback()
  const myToken = activeToken
  const chunks = splitTextIntoSpeechChunks(params.markdownText, 340)

  if (chunks.length === 0) {
    params.onError?.('낭독할 본문 텍스트가 없습니다.')
    return
  }

  emitSnapshot({ status: 'loading', activeId: params.id })

  let notifiedFallback = false
  const requestChunk = (chunkText: string): Promise<TtsSynthesizeResult> =>
    window.ck3Api.synthesizeTts({
      text: chunkText,
      ...params.overrides
    })

  try {
    let nextSynthPromise: Promise<TtsSynthesizeResult> | null = requestChunk(chunks[0])

    for (let idx = 0; idx < chunks.length; idx += 1) {
      if (myToken !== activeToken) return

      const currentResult = await nextSynthPromise!
      if (myToken !== activeToken) return

      // 현재 청크를 재생하는 동안 다음 청크를 백그라운드에서 미리 합성
      nextSynthPromise =
        idx + 1 < chunks.length
          ? requestChunk(chunks[idx + 1]).catch((err) => ({
              success: false,
              error: err instanceof Error ? err.message : String(err)
            }))
          : null

      if (!currentResult.success || !currentResult.audioBase64 || !currentResult.mimeType) {
        throw new Error(currentResult.error || '음성 합성에 실패했습니다.')
      }

      if (currentResult.usedFallback && currentResult.fallbackReason && !notifiedFallback) {
        notifiedFallback = true
        params.onFallbackNotice?.(currentResult.fallbackReason)
      }

      emitSnapshot({ status: 'playing', activeId: params.id })
      await playSingleBase64Audio(currentResult.audioBase64, currentResult.mimeType, myToken)
    }
  } catch (err) {
    if (myToken === activeToken) {
      const msg = err instanceof Error ? err.message : String(err)
      params.onError?.(msg)
    }
  } finally {
    if (myToken === activeToken) {
      emitSnapshot({ status: 'idle', activeId: null })
    }
  }
}
