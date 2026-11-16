import * as R from 'remeda'

/**
 * 마크다운 형식의 에이전트 답변에서 코드블록, 표 구분선, 기호 등을 제거하여
 * TTS 성우가 자연스러운 구어 문장으로 낭독할 수 있도록 정제합니다.
 * @param rawMarkdown 원본 마크다운 문자열
 * @returns 음성 낭독용 순수 평문 문자열
 */
export const sanitizeMarkdownForSpeech = (rawMarkdown: string): string => {
  if (!rawMarkdown) return ''

  const withoutCodeBlocks = rawMarkdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  const cleanedLines = R.pipe(
    withoutCodeBlocks.split(/\r?\n/),
    R.filter((line) => !/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)),
    R.map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s+/, '')
        .replace(/^\s*(?:[-*+]|[0-9]+\.|[○•])\s+/, '')
        .replace(/\|/g, ', ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_~#]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
    ),
    R.filter((line) => line.length > 0),
    R.map((line) => (/[.!?…]$/.test(line) ? line : `${line}.`))
  )

  return cleanedLines.join(' ').replace(/\s{2,}/g, ' ').trim()
}

/**
 * 긴 평문을 문장 경계 기준으로 자연스러운 길이의 음성 합성 청크 배열로 분할합니다.
 * 첫 청크를 빠르게 합성해 재생 지연을 줄이고 이후 청크를 백그라운드에서 선행 합성할 때 사용합니다.
 * @param rawText 원본 또는 마크다운 문자열
 * @param maxChunkChars 단일 청크 최대 글자 수
 * @returns 분할된 문장 청크 배열
 */
export const splitTextIntoSpeechChunks = (
  rawText: string,
  maxChunkChars = 340
): string[] => {
  const clean = sanitizeMarkdownForSpeech(rawText)
  if (!clean) return []

  const sentences = R.pipe(
    clean.split(/(?<=[.!?…])\s+/),
    R.map((s) => s.trim()),
    R.filter((s) => s.length > 0)
  )

  const chunks: string[] = []
  let buffer = ''

  for (const sentence of sentences) {
    if (sentence.length > maxChunkChars) {
      if (buffer) {
        chunks.push(buffer)
        buffer = ''
      }
      for (let idx = 0; idx < sentence.length; idx += maxChunkChars) {
        const sub = sentence.slice(idx, idx + maxChunkChars).trim()
        if (sub) chunks.push(sub)
      }
      continue
    }

    if (!buffer) {
      buffer = sentence
    } else if (buffer.length + 1 + sentence.length <= maxChunkChars) {
      buffer = `${buffer} ${sentence}`
    } else {
      chunks.push(buffer)
      buffer = sentence
    }
  }

  if (buffer) {
    chunks.push(buffer)
  }

  return chunks
}
