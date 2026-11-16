import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import AutoStoriesOutlinedIcon from '@mui/icons-material/AutoStoriesOutlined'
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded'
import CameraAltOutlinedIcon from '@mui/icons-material/CameraAltOutlined'
import CastleOutlinedIcon from '@mui/icons-material/CastleOutlined'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined'
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined'
import { getFontEmbedCSS, toBlob, toPng } from 'html-to-image'
import * as R from 'remeda'
import { FALLBACK_GEMINI_MODELS, PRESET_PROMPTS } from '@shared/constants'
import type {
  ChatMessage,
  ChatMode,
  GeminiModelOption,
  SaveSummary,
  ToolExecutionStep
} from '@shared/types'
import { FONT_FAMILIES, ROYAL_COLORS } from '@renderer/theme'
import {
  getTtsPlaybackSnapshot,
  playTtsForText,
  subscribeTtsPlayback
} from '@renderer/utils/ttsPlayer'
import appIconUrl from '@renderer/assets/app-icon.png?inline'

const TRANSPARENT_PIXEL_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQYV2NkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='

let cachedFontEmbedCssPromise: Promise<string> | null = null

const getCachedCaptureFontCss = (node: HTMLElement): Promise<string> => {
  if (window.location.protocol === 'file:') {
    return Promise.resolve('')
  }
  if (!cachedFontEmbedCssPromise) {
    cachedFontEmbedCssPromise = getFontEmbedCSS(node).catch(() => '')
  }
  return cachedFontEmbedCssPromise
}

export interface ChatAreaProps {
  messages: ChatMessage[]
  liveToolSteps: ToolExecutionStep[]
  streamingReplyText: string
  isSending: boolean
  hasApiKey: boolean
  chatMode: ChatMode
  selectedModel: string
  availableModels: GeminiModelOption[]
  saveSummary: SaveSummary | null
  sessionSaveContextLabel?: string
  onChangeMode: (nextMode: ChatMode) => void
  onSendMessage: (promptText: string) => void
  onCancelMessage: () => void
  onBranchFromMessage: (messageId: string) => void
  onSelectModel: (modelId: string) => void
  onLoadLatestSave: () => void
  onSelectSaveFile: () => void
  onOpenSettings: () => void
  onNotify: (message: string, severity?: 'success' | 'info' | 'warning' | 'error') => void
}

const formatCompactModelLabel = (modelId: string): string => {
  const clean = modelId.replace(/^models\//, '')
  const presetMap: Record<string, string> = {
    'gemini-3.8-flash': '3.8 Flash',
    'gemini-4-hydrogen': '4 Hydrogen',
    'gemini-4-argon': '4 Argon',
    'gemini-4-carbon': '4 Carbon'
  }
  if (presetMap[clean]) return presetMap[clean]
  return clean.replace(/^gemini-/, '')
}

const renderInlineFormatting = (text: string): React.ReactNode[] => {
  const tokens = text.split(/(\*\*[\s\S]+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*?\*)/g)
  return tokens.map((token, idx) => {
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return (
        <Box
          key={idx}
          component="strong"
          sx={{ color: '#FFFFFF', fontWeight: 700 }}
        >
          {token.slice(2, -2)}
        </Box>
      )
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return (
        <Box
          key={idx}
          component="code"
          sx={{
            px: 0.85,
            py: 0.2,
            mx: 0.25,
            borderRadius: '6px',
            fontSize: '0.84em',
            fontFamily: FONT_FAMILIES.MONO,
            backgroundColor: '#212329',
            color: '#E2E5EC',
            border: '1px solid rgba(255, 255, 255, 0.08)'
          }}
        >
          {token.slice(1, -1)}
        </Box>
      )
    }
    if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      return (
        <Box
          key={idx}
          component="em"
          sx={{ color: ROYAL_COLORS.SAGE_LIGHT, fontStyle: 'italic' }}
        >
          {token.slice(1, -1)}
        </Box>
      )
    }
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (linkMatch) {
      const label = linkMatch[1]
      const rawHref = linkMatch[2].trim()
      const isSafeHttp = /^https?:\/\//i.test(rawHref)
      if (isSafeHttp) {
        return (
          <Box
            key={idx}
            component="a"
            href={rawHref}
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              color: ROYAL_COLORS.GOLD_LIGHT,
              textDecoration: 'underline',
              '&:hover': { color: '#FFFFFF' }
            }}
          >
            {label}
          </Box>
        )
      }
      return (
        <Box
          key={idx}
          component="span"
          sx={{ color: ROYAL_COLORS.GOLD_LIGHT, textDecoration: 'underline' }}
        >
          {label}
        </Box>
      )
    }
    return <React.Fragment key={idx}>{token}</React.Fragment>
  })
}

const MarkdownContent: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split(/\r?\n/)
  const elements: React.ReactNode[] = []
  let idx = 0

  while (idx < lines.length) {
    const line = lines[idx]
    const trimmed = line.trim()

    if (!trimmed) {
      idx += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = []
      idx += 1
      while (idx < lines.length && !lines[idx].trim().startsWith('```')) {
        codeLines.push(lines[idx])
        idx += 1
      }
      idx += 1
      elements.push(
        <Box
          key={`code-${idx}`}
          component="pre"
          sx={{
            my: 1.75,
            p: 2,
            borderRadius: '8px',
            overflowX: 'auto',
            backgroundColor: '#17181C',
            border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
            fontFamily: FONT_FAMILIES.MONO,
            fontSize: '0.84rem',
            lineHeight: 1.6
          }}
        >
          {codeLines.join('\n')}
        </Box>
      )
      continue
    }

    if (
      trimmed.startsWith('|') &&
      idx + 1 < lines.length &&
      lines[idx + 1].trim().includes('---')
    ) {
      const parseCells = (rowStr: string): string[] =>
        R.pipe(
          rowStr.trim().replace(/^\||\|$/g, '').split('|'),
          R.map((c) => c.trim())
        )

      const headerCells = parseCells(lines[idx])
      idx += 2
      const bodyRows: string[][] = []
      while (idx < lines.length && lines[idx].trim().startsWith('|')) {
        bodyRows.push(parseCells(lines[idx]))
        idx += 1
      }

      elements.push(
        <Box
          key={`tbl-${idx}`}
          sx={{
            my: 2,
            overflowX: 'auto',
            borderRadius: '8px',
            backgroundColor: '#17181C',
            border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`
          }}
        >
          <Table size="small">
            <TableHead sx={{ backgroundColor: 'rgba(255, 255, 255, 0.04)' }}>
              <TableRow>
                {headerCells.map((cell, cIdx) => (
                  <TableCell
                    key={cIdx}
                    sx={{
                      fontFamily: FONT_FAMILIES.MYEONGJO,
                      fontWeight: 700,
                      color: ROYAL_COLORS.GOLD_LIGHT,
                      py: 1.1
                    }}
                  >
                    {renderInlineFormatting(cell)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {bodyRows.map((row, rIdx) => (
                <TableRow key={rIdx}>
                  {row.map((cell, cIdx) => (
                    <TableCell key={cIdx} sx={{ py: 0.95 }}>
                      {renderInlineFormatting(cell)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )
      continue
    }

    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      elements.push(<Divider key={`hr-${idx}`} sx={{ my: 2.5 }} />)
      idx += 1
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})(?:\s+(.*))?$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const headingText = (headingMatch[2] ?? '').replace(/\s+#+\s*$/, '').trim()

      // SSE 스트리밍 도중 '####' 기호만 먼저 도착한 프레임에서는 날것의 # 기호가 노출되지 않도록 대기
      if (!headingText) {
        idx += 1
        continue
      }

      const fontSizeByLevel: Record<number, string> = {
        1: '1.36rem',
        2: '1.2rem',
        3: '1.08rem',
        4: '0.99rem',
        5: '0.94rem',
        6: '0.9rem'
      }

      const colorByLevel: Record<number, string> = {
        1: ROYAL_COLORS.GOLD_LIGHT,
        2: '#F3F4F6',
        3: ROYAL_COLORS.GOLD_LIGHT,
        4: ROYAL_COLORS.SAGE_LIGHT,
        5: '#E2E5EC',
        6: ROYAL_COLORS.TEXT_SECONDARY
      }

      elements.push(
        <Typography
          key={`h${level}-${idx}`}
          sx={{
            fontFamily: FONT_FAMILIES.MYEONGJO,
            fontSize: fontSizeByLevel[level] ?? '0.98rem',
            fontWeight: 700,
            color: colorByLevel[level] ?? ROYAL_COLORS.SAGE_LIGHT,
            mt: level <= 2 ? 2.75 : level === 3 ? 2.25 : 1.75,
            mb: level <= 3 ? 0.9 : 0.55
          }}
        >
          {renderInlineFormatting(headingText)}
        </Typography>
      )
      idx += 1
      continue
    }

    if (trimmed === '>' || /^[-*•]$/.test(trimmed)) {
      idx += 1
      continue
    }

    if (trimmed.startsWith('> ')) {
      elements.push(
        <Box
          key={`quote-${idx}`}
          sx={{
            my: 1.5,
            pl: 2,
            py: 0.4,
            borderLeft: `2px dotted rgba(212, 175, 90, 0.55)`,
            color: '#C4C7CE'
          }}
        >
          <Typography variant="body1" sx={{ fontSize: '0.95rem', lineHeight: 1.8 }}>
            {renderInlineFormatting(trimmed.slice(2))}
          </Typography>
        </Box>
      )
      idx += 1
      continue
    }

    const bulletMatch = line.match(/^(\s*)([-*•]|\d+\.)\s+(.+)$/)
    if (bulletMatch) {
      const indentLevel = Math.min(3, Math.floor((bulletMatch[1]?.length ?? 0) / 2))
      const marker = bulletMatch[2]
      const body = bulletMatch[3]
      elements.push(
        <Stack
          key={`li-${idx}`}
          direction="row"
          spacing={1.5}
          alignItems="flex-start"
          sx={{ pl: indentLevel * 2.25 + 0.5, my: 0.7 }}
        >
          <Typography
            sx={{
              color: marker.endsWith('.') ? ROYAL_COLORS.GOLD_LIGHT : ROYAL_COLORS.TEXT_SECONDARY,
              fontSize: marker.endsWith('.') ? '0.92rem' : '0.78rem',
              lineHeight: 2.1,
              minWidth: 16
            }}
          >
            {marker.endsWith('.') ? marker : '○'}
          </Typography>
          <Typography sx={{ fontSize: '0.96rem', lineHeight: 1.8, flex: 1, color: '#E3E5EA' }}>
            {renderInlineFormatting(body)}
          </Typography>
        </Stack>
      )
      idx += 1
      continue
    }

    elements.push(
      <Typography
        key={`p-${idx}`}
        sx={{ my: 1.1, fontSize: '0.96rem', lineHeight: 1.82, color: '#E3E5EA' }}
      >
        {renderInlineFormatting(line)}
      </Typography>
    )
    idx += 1
  }

  return <Box>{elements}</Box>
}

const ToolStepsPanel: React.FC<{ steps: ToolExecutionStep[]; defaultExpanded?: boolean }> = ({
  steps,
  defaultExpanded = false
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [userToggled, setUserToggled] = useState(false)

  useEffect(() => {
    if (!userToggled) {
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded, userToggled])

  if (!steps || steps.length === 0) return null

  const runningCount = steps.filter((s) => s.status === 'running').length

  return (
    <Box
      sx={{
        mb: 1.75,
        px: 1.75,
        py: 1,
        borderRadius: '8px',
        backgroundColor: '#16181D',
        border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`
      }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        onClick={() => {
          setUserToggled(true)
          setExpanded((prev) => !prev)
        }}
        sx={{ cursor: 'pointer' }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          {runningCount > 0 ? (
            <CircularProgress size={13} color="primary" />
          ) : (
            <HandymanOutlinedIcon sx={{ fontSize: 15, color: ROYAL_COLORS.GOLD_MAIN }} />
          )}
          <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY, fontWeight: 500 }}>
            {runningCount > 0
              ? `세이브 및 모드 스크립트 교차 조회 중 · ${steps.length}단계`
              : `교차 검증 완료 · 도구 ${steps.length}회 실행됨`}
          </Typography>
        </Stack>
        <IconButton size="small" sx={{ p: 0.2, color: ROYAL_COLORS.TEXT_SECONDARY }}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Stack>

      <Collapse in={expanded || runningCount > 0}>
        <Stack
          spacing={0.65}
          sx={{
            mt: 1,
            pt: 0.85,
            pl: 1.25,
            borderTop: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
            borderLeft: `2px solid rgba(212, 175, 90, 0.28)`
          }}
        >
          {steps.map((step) => (
            <Stack
              key={step.id}
              direction="row"
              spacing={1}
              alignItems="center"
              justifyContent="space-between"
              sx={{ py: 0.25 }}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ overflow: 'hidden' }}>
                {step.status === 'running' && <CircularProgress size={12} color="primary" />}
                {step.status === 'completed' && (
                  <CheckCircleOutlineIcon sx={{ fontSize: 14, color: '#5BB98B' }} />
                )}
                {step.status === 'error' && (
                  <ErrorOutlineIcon sx={{ fontSize: 14, color: '#E06666' }} />
                )}

                <Typography variant="caption" sx={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {step.displayTitle}
                </Typography>

                {step.resultSummary && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: ROYAL_COLORS.TEXT_SECONDARY,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    · {step.resultSummary}
                  </Typography>
                )}
              </Stack>

              {step.durationMs !== undefined && (
                <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                  {step.durationMs}ms
                </Typography>
              )}
            </Stack>
          ))}
        </Stack>
      </Collapse>
    </Box>
  )
}

const AssistantMessageView: React.FC<{
  message: ChatMessage
  saveSummary: SaveSummary | null
  sessionSaveContextLabel?: string
  onBranch: (messageId: string) => void
  onNotify: ChatAreaProps['onNotify']
}> = ({ message, saveSummary, sessionSaveContextLabel, onBranch, onNotify }) => {
  const captureRef = useRef<HTMLDivElement | null>(null)
  const [capturing, setCapturing] = useState(false)
  const ttsSnapshot = useSyncExternalStore(subscribeTtsPlayback, getTtsPlaybackSnapshot)
  const isThisTtsActive = ttsSnapshot.activeId === message.id
  const isTtsLoading = isThisTtsActive && ttsSnapshot.status === 'loading'
  const isTtsPlaying = isThisTtsActive && ttsSnapshot.status === 'playing'

  const handleToggleTts = (): void => {
    void playTtsForText({
      id: message.id,
      markdownText: message.content,
      onFallbackNotice: (reason) => onNotify(reason, 'info'),
      onError: (errMsg) => onNotify(errMsg, 'warning')
    })
  }

  const captureFilter = (node: HTMLElement): boolean =>
    !(node instanceof HTMLElement && node.dataset?.excludeCapture === 'true')

  const buildCaptureOptions = async (targetEl: HTMLDivElement) => {
    const innerTables = Array.from(targetEl.querySelectorAll('table'))
    const widestTable = innerTables.reduce((maxW, tbl) => Math.max(maxW, tbl.scrollWidth + 56), 0)
    const targetWidth = Math.max(targetEl.scrollWidth, targetEl.offsetWidth, widestTable) + 48
    const actionRow = targetEl.querySelector('[data-exclude-capture="true"]') as HTMLElement | null
    const actionHeight = actionRow ? actionRow.offsetHeight + 12 : 0
    const targetHeight = Math.max(120, targetEl.scrollHeight - actionHeight + 48)
    const isFileProtocol = window.location.protocol === 'file:'
    const fontEmbedCSS = await getCachedCaptureFontCss(targetEl)

    return {
      backgroundColor: '#131722',
      pixelRatio: 2,
      cacheBust: false,
      skipFonts: isFileProtocol,
      ...(fontEmbedCSS ? { fontEmbedCSS } : {}),
      imagePlaceholder: TRANSPARENT_PIXEL_PLACEHOLDER,
      width: targetWidth,
      height: targetHeight,
      style: {
        padding: '24px',
        borderRadius: '14px',
        width: `${targetWidth}px`,
        boxSizing: 'border-box'
      },
      filter: captureFilter as (node: Node) => boolean
    }
  }

  const handleCopyAsImage = async (): Promise<void> => {
    if (!captureRef.current || capturing) return
    setCapturing(true)
    try {
      const options = await buildCaptureOptions(captureRef.current)
      const blob = await toBlob(captureRef.current, options)
      if (!blob) throw new Error('이미지 Blob 생성에 실패했습니다.')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      onNotify('조언 내용이 클립보드에 고해상도 이미지로 복사되었습니다.', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onNotify(`이미지 복사 실패: ${msg}`, 'error')
    } finally {
      setCapturing(false)
    }
  }

  const handleDownloadPng = async (): Promise<void> => {
    if (!captureRef.current || capturing) return
    setCapturing(true)
    try {
      const options = await buildCaptureOptions(captureRef.current)
      const dataUrl = await toPng(captureRef.current, options)
      const anchor = document.createElement('a')
      anchor.href = dataUrl
      anchor.download = `ck3-gemini-agent-${Date.now()}.png`
      anchor.click()
      onNotify('PNG 이미지로 저장되었습니다.', 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onNotify(`이미지 저장 실패: ${msg}`, 'error')
    } finally {
      setCapturing(false)
    }
  }

  const handleCopyText = async (): Promise<void> => {
    await navigator.clipboard.writeText(message.content)
    onNotify('마크다운 텍스트가 클립보드에 복사되었습니다.', 'info')
  }

  return (
    <Box
      ref={captureRef}
      sx={{
        py: 1,
        px: message.isError ? 2 : 0.5,
        borderRadius: '8px',
        backgroundColor: message.isError ? 'rgba(224, 102, 102, 0.08)' : 'transparent'
      }}
    >
      {/* Subtle Gemini-style Spark Header */}
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1.25 }}>
        <Box
          component="img"
          src={appIconUrl}
          alt="Gemini CK3"
          sx={{ width: 22, height: 22, display: 'block' }}
        />
        <Typography
          variant="caption"
          sx={{
            fontFamily: FONT_FAMILIES.MYEONGJO,
            color:
              message.modeUsed === 'general_advisor'
                ? ROYAL_COLORS.SAGE_LIGHT
                : ROYAL_COLORS.GOLD_LIGHT,
            fontWeight: 700
          }}
        >
          {message.modeUsed === 'general_advisor'
            ? 'CK3 현인 자문'
            : 'CK3 제미나이 에이전트'}
        </Typography>
        {message.modeUsed === 'general_advisor' ? (
          <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
            · 일반 질문 모드
          </Typography>
        ) : (
          (sessionSaveContextLabel || saveSummary) && (
            <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
              ·{' '}
              {sessionSaveContextLabel ||
                (saveSummary ? `${saveSummary.playerName} · ${saveSummary.gameDate}년` : '')}
            </Typography>
          )
        )}
      </Stack>

      {message.toolSteps && message.toolSteps.length > 0 && (
        <ToolStepsPanel steps={message.toolSteps} />
      )}

      <Box sx={{ pl: { xs: 0, sm: 0.5 } }}>
        <MarkdownContent content={message.content} />
      </Box>

      {/* Minimalist Gemini-style Bottom Action Row */}
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        data-exclude-capture="true"
        sx={{ mt: 1.5, pt: 0.5 }}
      >
        {!message.isError && (
          <Tooltip title={isThisTtsActive ? '음성 낭독 중지' : '음성으로 듣기'} arrow>
            <IconButton
              size="small"
              onClick={handleToggleTts}
              sx={{
                color: isThisTtsActive ? ROYAL_COLORS.GOLD_LIGHT : ROYAL_COLORS.TEXT_SECONDARY,
                '&:hover': { color: ROYAL_COLORS.GOLD_LIGHT }
              }}
            >
              {isTtsLoading ? (
                <CircularProgress size={15} color="primary" />
              ) : isTtsPlaying ? (
                <StopCircleOutlinedIcon sx={{ fontSize: 18 }} />
              ) : (
                <VolumeUpOutlinedIcon sx={{ fontSize: 18 }} />
              )}
            </IconButton>
          </Tooltip>
        )}

        <Tooltip title="답변을 클립보드에 이미지로 캡처/복사" arrow>
          <span>
            <IconButton
              size="small"
              disabled={capturing}
              onClick={() => void handleCopyAsImage()}
              sx={{ color: ROYAL_COLORS.TEXT_SECONDARY, '&:hover': { color: '#FFF' } }}
            >
              {capturing ? (
                <CircularProgress size={15} />
              ) : (
                <CameraAltOutlinedIcon sx={{ fontSize: 18 }} />
              )}
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="PNG 이미지 다운로드" arrow>
          <span>
            <IconButton
              size="small"
              disabled={capturing}
              onClick={() => void handleDownloadPng()}
              sx={{ color: ROYAL_COLORS.TEXT_SECONDARY, '&:hover': { color: '#FFF' } }}
            >
              <DownloadOutlinedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="텍스트 복사" arrow>
          <IconButton
            size="small"
            onClick={() => void handleCopyText()}
            sx={{ color: ROYAL_COLORS.TEXT_SECONDARY, '&:hover': { color: '#FFF' } }}
          >
            <ContentCopyOutlinedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>

        {!message.isError && (
          <Tooltip title="이 답변까지 포함해 새 채팅으로 분기" arrow>
            <IconButton
              size="small"
              onClick={() => onBranch(message.id)}
              sx={{ color: ROYAL_COLORS.TEXT_SECONDARY, '&:hover': { color: ROYAL_COLORS.GOLD_LIGHT } }}
            >
              <CallSplitRoundedIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
        )}

        {message.modelUsed && (
          <Typography variant="caption" sx={{ ml: 1, color: '#8E949E' }}>
            {formatCompactModelLabel(message.modelUsed)}
          </Typography>
        )}
      </Stack>
    </Box>
  )
}

const StreamingRevealText: React.FC<{ targetText: string; isStreaming: boolean }> = ({
  targetText,
  isStreaming
}) => {
  const [displayedText, setDisplayedText] = useState('')
  const targetRef = useRef(targetText)
  const displayedLenRef = useRef(0)

  targetRef.current = targetText

  useEffect(() => {
    if (!targetText) {
      displayedLenRef.current = 0
      setDisplayedText('')
    }
  }, [targetText])

  useEffect(() => {
    if (!isStreaming) {
      displayedLenRef.current = targetRef.current.length
      setDisplayedText(targetRef.current)
      return
    }

    let rafId = 0
    const tick = (): void => {
      const full = targetRef.current
      const cur = displayedLenRef.current
      if (cur < full.length) {
        const backlog = full.length - cur
        // SSE 청크가 뭉쳐 들어오더라도 매 프레임 자연스럽게 글자가 흘러나오도록 적응형 가속 보간
        const step = Math.max(2, Math.ceil(backlog * 0.24))
        const nextLen = Math.min(full.length, cur + step)
        displayedLenRef.current = nextLen
        setDisplayedText(full.slice(0, nextLen))
      }
      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [isStreaming])

  if (!displayedText) return null

  return (
    <Box
      sx={{
        pl: { xs: 0, sm: 0.5 },
        '@keyframes ck3CursorBlink': {
          '0%, 49%': { opacity: 1 },
          '50%, 100%': { opacity: 0.15 }
        },
        '& > div > *:last-child::after': {
          content: '""',
          display: 'inline-block',
          width: '7px',
          height: '15px',
          ml: 0.5,
          verticalAlign: 'text-bottom',
          borderRadius: '2px',
          backgroundColor: ROYAL_COLORS.GOLD_LIGHT,
          animation: 'ck3CursorBlink 0.9s infinite ease-in-out'
        }
      }}
    >
      <MarkdownContent content={displayedText} />
    </Box>
  )
}

const ChatModeSwitchPill: React.FC<{
  mode: ChatMode
  disabled?: boolean
  compact?: boolean
  onChange: (nextMode: ChatMode) => void
}> = ({ mode, disabled = false, compact = false, onChange }) => (
  <Stack
    direction="row"
    spacing={0.5}
    alignItems="center"
    sx={{
      display: 'inline-flex',
      p: 0.4,
      borderRadius: '10px',
      backgroundColor: '#191B20',
      border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
      flexShrink: 0
    }}
  >
    <Tooltip
      title="로드된 .ck3 세이브의 내 군주·직할령·봉신·전쟁 수치와 모드 스크립트를 정밀 교차 분석합니다"
      arrow
    >
      <Box
        onClick={() => {
          if (!disabled) onChange('save_analysis')
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.65,
          px: compact ? 1.15 : 1.5,
          py: compact ? 0.35 : 0.55,
          borderRadius: '7px',
          cursor: disabled ? 'default' : 'pointer',
          fontSize: compact ? '0.75rem' : '0.81rem',
          fontWeight: mode === 'save_analysis' ? 700 : 400,
          color: mode === 'save_analysis' ? ROYAL_COLORS.GOLD_LIGHT : ROYAL_COLORS.TEXT_SECONDARY,
          backgroundColor: mode === 'save_analysis' ? 'rgba(212, 175, 90, 0.14)' : 'transparent',
          border:
            mode === 'save_analysis'
              ? `1px solid ${ROYAL_COLORS.GOLD_DIM}`
              : '1px solid transparent',
          transition: 'all 0.15s ease',
          '&:hover': {
            color: mode === 'save_analysis' ? ROYAL_COLORS.GOLD_LIGHT : '#FFFFFF'
          }
        }}
      >
        <CastleOutlinedIcon sx={{ fontSize: compact ? 14 : 15 }} />
        <span>세이브 판세 분석</span>
      </Box>
    </Tooltip>

    <Tooltip
      title="세이브 파일을 뒤지지 않고 CK3 성격·트레잇·무장병·모드 메카닉 질문에만 빠르게 답변합니다"
      arrow
    >
      <Box
        onClick={() => {
          if (!disabled) onChange('general_advisor')
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.65,
          px: compact ? 1.15 : 1.5,
          py: compact ? 0.35 : 0.55,
          borderRadius: '7px',
          cursor: disabled ? 'default' : 'pointer',
          fontSize: compact ? '0.75rem' : '0.81rem',
          fontWeight: mode === 'general_advisor' ? 700 : 400,
          color: mode === 'general_advisor' ? ROYAL_COLORS.SAGE_LIGHT : ROYAL_COLORS.TEXT_SECONDARY,
          backgroundColor: mode === 'general_advisor' ? 'rgba(200, 184, 152, 0.14)' : 'transparent',
          border:
            mode === 'general_advisor'
              ? `1px solid ${ROYAL_COLORS.SAGE_DIM}`
              : '1px solid transparent',
          transition: 'all 0.15s ease',
          '&:hover': {
            color: mode === 'general_advisor' ? ROYAL_COLORS.SAGE_LIGHT : '#FFFFFF'
          }
        }}
      >
        <AutoStoriesOutlinedIcon sx={{ fontSize: compact ? 14 : 15 }} />
        <span>일반 질문 · 현인</span>
      </Box>
    </Tooltip>
  </Stack>
)

interface PromptOmnibarProps {
  inputValue: string
  isSending: boolean
  chatMode: ChatMode
  selectedModel: string
  availableModels: GeminiModelOption[]
  onInputChange: (val: string) => void
  onTriggerSend: () => void
  onCancelSend: () => void
  onSelectModel: (modelId: string) => void
  onLoadLatestSave: () => void
  onSelectSaveFile: () => void
  onOpenSettings: () => void
}

const GeminiPromptOmnibar: React.FC<PromptOmnibarProps> = ({
  inputValue,
  isSending,
  chatMode,
  selectedModel,
  availableModels,
  onInputChange,
  onTriggerSend,
  onCancelSend,
  onSelectModel,
  onLoadLatestSave,
  onSelectSaveFile,
  onOpenSettings
}) => {
  const [plusAnchor, setPlusAnchor] = useState<null | HTMLElement>(null)
  const [modelAnchor, setModelAnchor] = useState<null | HTMLElement>(null)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onTriggerSend()
    }
  }

  const modelMenuItems = R.pipe(
    [...availableModels, ...FALLBACK_GEMINI_MODELS],
    R.uniqueBy((m) => m.id),
    R.take(10)
  )

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.75,
        py: 0.85,
        borderRadius: '18px',
        backgroundColor: ROYAL_COLORS.BG_PILL,
        border: '1px solid rgba(255, 255, 255, 0.09)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
        transition: 'border-color 0.2s ease, background-color 0.2s ease',
        '&:focus-within': {
          backgroundColor: '#22242B',
          borderColor: 'rgba(212, 175, 90, 0.42)'
        }
      }}
    >
      {/* Left '+' Save Menu Trigger */}
      <Tooltip title="세이브 불러오기 메뉴" arrow>
        <IconButton
          size="small"
          onClick={(e) => setPlusAnchor(e.currentTarget)}
          sx={{
            width: 36,
            height: 36,
            color: ROYAL_COLORS.TEXT_SECONDARY,
            '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)', color: '#FFF' }
          }}
        >
          <AddIcon sx={{ fontSize: 22 }} />
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={plusAnchor}
        open={Boolean(plusAnchor)}
        onClose={() => setPlusAnchor(null)}
        slotProps={{
          paper: {
            sx: {
              backgroundColor: '#202229',
              borderRadius: '8px',
              minWidth: 210
            }
          }
        }}
      >
        <MenuItem
          onClick={() => {
            setPlusAnchor(null)
            onLoadLatestSave()
          }}
        >
          최신 .ck3 세이브 자동 로드
        </MenuItem>
        <MenuItem
          onClick={() => {
            setPlusAnchor(null)
            onSelectSaveFile()
          }}
        >
          세이브 파일 직접 찾아보기...
        </MenuItem>
      </Menu>

      {/* Center Input */}
      <TextField
        fullWidth
        multiline
        maxRows={6}
        size="small"
        variant="standard"
        placeholder={
          chatMode === 'general_advisor'
            ? '성격·트레잇·무장병·모드 메카닉 가볍게 물어보기'
            : '내 군주·직할령·봉신·전쟁 판세 물어보기'
        }
        value={inputValue}
        disabled={isSending}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        slotProps={{
          input: {
            disableUnderline: true,
            sx: {
              px: 0.5,
              py: 0.6,
              fontSize: '0.96rem',
              color: ROYAL_COLORS.TEXT_PRIMARY,
              '& input::placeholder, & textarea::placeholder': {
                color: ROYAL_COLORS.TEXT_SECONDARY,
                opacity: 1
              }
            }
          }
        }}
      />

      {/* Right Inline Model Selector Pill (like Gemini's '카본 v') */}
      <Button
        size="small"
        endIcon={<KeyboardArrowDownRoundedIcon sx={{ fontSize: 18 }} />}
        onClick={(e) => setModelAnchor(e.currentTarget)}
        sx={{
          px: 1.4,
          py: 0.5,
          flexShrink: 0,
          fontSize: '0.8rem',
          color: ROYAL_COLORS.TEXT_SECONDARY,
          borderRadius: 999,
          '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)', color: '#FFF' }
        }}
      >
        {formatCompactModelLabel(selectedModel)}
      </Button>

      <Menu
        anchorEl={modelAnchor}
        open={Boolean(modelAnchor)}
        onClose={() => setModelAnchor(null)}
        slotProps={{
          paper: {
            sx: {
              backgroundColor: '#202229',
              borderRadius: '8px',
              minWidth: 250
            }
          }
        }}
      >
        {modelMenuItems.map((m) => (
          <MenuItem
            key={m.id}
            selected={m.id === selectedModel}
            onClick={() => {
              onSelectModel(m.id)
              setModelAnchor(null)
            }}
          >
            <Box>
              <Typography variant="body2" sx={{ fontWeight: m.id === selectedModel ? 700 : 400 }}>
                {formatCompactModelLabel(m.id)}
              </Typography>
              <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                {m.id}
              </Typography>
            </Box>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            setModelAnchor(null)
            onOpenSettings()
          }}
        >
          <TuneRoundedIcon sx={{ fontSize: 16, mr: 1, color: ROYAL_COLORS.GOLD_LIGHT }} />
          <Typography variant="caption">모델 직접 입력 및 API 설정...</Typography>
        </MenuItem>
      </Menu>

      {/* Circular Send / Stop Button */}
      {isSending ? (
        <Tooltip title="응답 생성 중단" arrow>
          <IconButton
            onClick={onCancelSend}
            sx={{
              width: 38,
              height: 38,
              flexShrink: 0,
              backgroundColor: 'rgba(224, 102, 102, 0.16)',
              color: '#F28B82',
              border: '1px solid rgba(224, 102, 102, 0.35)',
              '&:hover': {
                backgroundColor: 'rgba(224, 102, 102, 0.26)'
              }
            }}
          >
            <StopRoundedIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>
      ) : (
        <IconButton
          disabled={!inputValue.trim()}
          onClick={onTriggerSend}
          sx={{
            width: 38,
            height: 38,
            flexShrink: 0,
            backgroundColor: inputValue.trim() ? ROYAL_COLORS.GOLD_MAIN : 'rgba(255,255,255,0.06)',
            color: inputValue.trim() ? '#101114' : ROYAL_COLORS.TEXT_SECONDARY,
            '&:hover': {
              backgroundColor: inputValue.trim() ? ROYAL_COLORS.GOLD_LIGHT : 'rgba(255,255,255,0.1)'
            },
            '&.Mui-disabled': {
              backgroundColor: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.22)'
            }
          }}
        >
          <ArrowUpwardRoundedIcon sx={{ fontSize: 21 }} />
        </IconButton>
      )}
    </Box>
  )
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  liveToolSteps,
  streamingReplyText,
  isSending,
  hasApiKey,
  chatMode,
  selectedModel,
  availableModels,
  saveSummary,
  sessionSaveContextLabel,
  onChangeMode,
  onSendMessage,
  onCancelMessage,
  onBranchFromMessage,
  onSelectModel,
  onLoadLatestSave,
  onSelectSaveFile,
  onOpenSettings,
  onNotify
}) => {
  const [inputValue, setInputValue] = useState('')
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const streamStackRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef<boolean>(true)
  const isGeneralMode = chatMode === 'general_advisor'

  const filteredPresets = R.pipe(
    PRESET_PROMPTS,
    R.filter((p) => p.mode === chatMode)
  )

  const handleStreamScroll = (): void => {
    const el = scrollContainerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    shouldAutoScrollRef.current = distanceFromBottom < 120
  }

  useEffect(() => {
    const el = scrollContainerRef.current
    if (el && shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, liveToolSteps, streamingReplyText, isSending])

  useEffect(() => {
    const container = scrollContainerRef.current
    const stackEl = streamStackRef.current
    if (!container || !stackEl || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) {
        container.scrollTop = container.scrollHeight
      }
    })
    observer.observe(stackEl)
    return () => observer.disconnect()
  }, [messages.length, isSending])

  const triggerSend = (): void => {
    const trimmed = inputValue.trim()
    if (!trimmed || isSending) return
    shouldAutoScrollRef.current = true
    setInputValue('')
    onSendMessage(trimmed)
  }

  const isEmptyHero = messages.length === 0 && !isSending

  if (isEmptyHero) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          px: 2.5,
          pb: 6,
          position: 'relative',
          overflowY: 'auto'
        }}
      >
        <Stack
          spacing={2.5}
          alignItems="center"
          sx={{ width: '100%', maxWidth: 740, zIndex: 2 }}
        >
          {/* Gemini × CK3 Hero Greeting */}
          <Box sx={{ textAlign: 'center' }}>
            <Typography
              sx={{
                fontFamily: FONT_FAMILIES.MYEONGJO,
                fontSize: { xs: '1.85rem', sm: '2.25rem' },
                fontWeight: 500,
                color: '#F1F3F4',
                letterSpacing: '-0.02em',
                mb: 0.75
              }}
            >
              {isGeneralMode
                ? '무엇이 궁금하신가요?'
                : saveSummary
                  ? `무엇을 도와드릴까요, ${saveSummary.playerName}?`
                  : '무엇을 도와드릴까요?'}
            </Typography>

            <Typography
              variant="body2"
              sx={{
                fontFamily: FONT_FAMILIES.MYEONGJO,
                color: isGeneralMode ? ROYAL_COLORS.SAGE_LIGHT : ROYAL_COLORS.GOLD_LIGHT,
                opacity: 0.9
              }}
            >
              {isGeneralMode
                ? '세이브 탐색 없이 트레잇·무장병·문화·종교·모드 메카닉만 빠르게 문답합니다'
                : saveSummary
                  ? `${saveSummary.primaryTitleName || saveSummary.primaryTitleKey} · ${saveSummary.gameDate}년 정세 및 모드 스크립트 교차 분석 준비됨`
                  : '우측 상단에서 .ck3 세이브를 불러오면 내 캠페인 판세를 정밀 진단합니다'}
            </Typography>

            {!hasApiKey && (
              <Button
                size="small"
                variant="outlined"
                color="primary"
                onClick={onOpenSettings}
                sx={{ mt: 1, fontSize: '0.78rem' }}
              >
                시작하기 전 Gemini API 키 등록하기
              </Button>
            )}
          </Box>

          {/* Centered Gemini Pill Omnibar */}
          <Box sx={{ width: '100%' }}>
            <GeminiPromptOmnibar
              inputValue={inputValue}
              isSending={isSending}
              chatMode={chatMode}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onInputChange={setInputValue}
              onTriggerSend={triggerSend}
              onCancelSend={onCancelMessage}
              onSelectModel={onSelectModel}
              onLoadLatestSave={onLoadLatestSave}
              onSelectSaveFile={onSelectSaveFile}
              onOpenSettings={onOpenSettings}
            />
          </Box>

          {/* Gemini-style Segmented Mode Switcher right under Omnibar */}
          <ChatModeSwitchPill mode={chatMode} onChange={onChangeMode} />

          {/* Mode-Specific Strategy Preset Pills */}
          <Stack
            direction="row"
            flexWrap="wrap"
            justifyContent="center"
            gap={1}
            sx={{ maxWidth: 680 }}
          >
            {filteredPresets.map((preset) => (
              <Chip
                key={preset.key}
                label={preset.label}
                clickable
                onClick={() => onSendMessage(preset.prompt)}
                sx={{
                  height: 35,
                  px: 0.85,
                  fontSize: '0.81rem',
                  color: '#D4D7DD',
                  backgroundColor: ROYAL_COLORS.BG_PILL,
                  border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
                  transition: 'all 0.15s ease',
                  '&:hover': {
                    backgroundColor: ROYAL_COLORS.BG_PILL_HOVER,
                    borderColor: isGeneralMode
                      ? ROYAL_COLORS.SAGE_DIM
                      : ROYAL_COLORS.GOLD_DIM,
                    color: isGeneralMode ? ROYAL_COLORS.SAGE_LIGHT : ROYAL_COLORS.GOLD_LIGHT
                  }
                }}
              />
            ))}
          </Stack>
        </Stack>
      </Box>
    )
  }

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 2
      }}
    >
      {/* Active Conversation Stream */}
      <Box
        ref={scrollContainerRef}
        onScroll={handleStreamScroll}
        sx={{
          flex: 1,
          overflowY: 'auto',
          px: 2.5,
          pt: 2,
          pb: 3
        }}
      >
        <Stack
          ref={streamStackRef}
          spacing={3.5}
          sx={{
            width: '100%',
            maxWidth: 820,
            mx: 'auto'
          }}
        >
          {messages.map((msg) =>
            msg.role === 'user' ? (
              <Box
                key={msg.id}
                sx={{
                  alignSelf: 'flex-end',
                  maxWidth: '78%',
                  px: 2.25,
                  py: 1.25,
                  borderRadius: '12px 12px 4px 12px',
                  backgroundColor: ROYAL_COLORS.BG_USER_BUBBLE
                }}
              >
                <Typography
                  sx={{
                    whiteSpace: 'pre-wrap',
                    fontSize: '0.95rem',
                    lineHeight: 1.7,
                    color: ROYAL_COLORS.TEXT_PRIMARY
                  }}
                >
                  {msg.content}
                </Typography>
              </Box>
            ) : (
              <AssistantMessageView
                key={msg.id}
                message={msg}
                saveSummary={saveSummary}
                sessionSaveContextLabel={sessionSaveContextLabel}
                onBranch={onBranchFromMessage}
                onNotify={onNotify}
              />
            )
          )}

          {isSending && (
            <Box sx={{ py: 1, px: 0.5 }}>
              <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1.25 }}>
                <Box
                  component="img"
                  src={appIconUrl}
                  alt="Analyzing"
                  sx={{ width: 22, height: 22, display: 'block' }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    fontFamily: FONT_FAMILIES.MYEONGJO,
                    color: isGeneralMode ? ROYAL_COLORS.SAGE_LIGHT : ROYAL_COLORS.GOLD_LIGHT,
                    fontWeight: 700
                  }}
                >
                  {streamingReplyText
                    ? isGeneralMode
                      ? 'CK3 현인 자문'
                      : 'CK3 제미나이 에이전트'
                    : isGeneralMode
                      ? '현인이 게임 메카닉과 스크립트 데이터를 살펴보고 있습니다...'
                      : '세이브 데이터와 모드 스크립트를 교차 분석하고 있습니다...'}
                </Typography>
                {streamingReplyText && !isGeneralMode && saveSummary && (
                  <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                    · {saveSummary.playerName} · {saveSummary.gameDate}년
                  </Typography>
                )}
              </Stack>

              <ToolStepsPanel
                steps={liveToolSteps}
                defaultExpanded={!streamingReplyText}
              />

              <StreamingRevealText
                targetText={streamingReplyText}
                isStreaming={isSending}
              />
            </Box>
          )}
        </Stack>
      </Box>

      {/* Bottom Docked Gemini Pill Omnibar */}
      <Box sx={{ px: 2.5, pb: 1.75, pt: 0.75 }}>
        <Box sx={{ width: '100%', maxWidth: 820, mx: 'auto' }}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ mb: 1, overflowX: 'auto', pb: 0.25 }}
          >
            <ChatModeSwitchPill
              mode={chatMode}
              disabled={isSending}
              compact
              onChange={onChangeMode}
            />

            {filteredPresets.map((preset) => (
              <Chip
                key={preset.key}
                size="small"
                label={preset.label}
                clickable
                disabled={isSending}
                onClick={() => {
                  shouldAutoScrollRef.current = true
                  onSendMessage(preset.prompt)
                }}
                sx={{
                  flexShrink: 0,
                  height: 28,
                  fontSize: '0.76rem',
                  color: ROYAL_COLORS.TEXT_SECONDARY,
                  backgroundColor: ROYAL_COLORS.BG_PILL,
                  border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
                  '&:hover': {
                    backgroundColor: ROYAL_COLORS.BG_PILL_HOVER,
                    color: isGeneralMode ? ROYAL_COLORS.SAGE_LIGHT : ROYAL_COLORS.GOLD_LIGHT
                  }
                }}
              />
            ))}
          </Stack>

          <GeminiPromptOmnibar
            inputValue={inputValue}
            isSending={isSending}
            chatMode={chatMode}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onInputChange={setInputValue}
            onTriggerSend={triggerSend}
            onCancelSend={onCancelMessage}
            onSelectModel={onSelectModel}
            onLoadLatestSave={onLoadLatestSave}
            onSelectSaveFile={onSelectSaveFile}
            onOpenSettings={onOpenSettings}
          />

          <Typography
            variant="caption"
            sx={{
              display: 'block',
              textAlign: 'center',
              mt: 1,
              fontSize: '0.72rem',
              color: '#8E949E'
            }}
          >
            CK3 제미나이 에이전트는 로드된 세이브와 VFS 병합 스크립트를 기반으로 조언하며, AI 특성상 실수를 할 수 있습니다.
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}
