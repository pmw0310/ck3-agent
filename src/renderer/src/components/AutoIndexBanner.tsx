import React, { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import CloseIcon from '@mui/icons-material/Close'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import FolderOffIcon from '@mui/icons-material/FolderOff'
import StopCircleIcon from '@mui/icons-material/StopCircle'
import * as R from 'remeda'
import type { IndexPhase, IndexProgressPayload, VersionCheckResult } from '@shared/types'
import { ROYAL_COLORS } from '@renderer/theme'

export interface AutoIndexBannerProps {
  versionCheck: VersionCheckResult | null
  indexProgress: IndexProgressPayload | null
  isIndexing: boolean
  dismissed: boolean
  onStartIndexing: () => void
  onCancelIndexing: () => void
  onDismiss: () => void
  onOpenSettings: () => void
}

const PHASE_LABELS: Record<IndexPhase, string> = {
  idle: '대기 중',
  'scanning-vfs': '1/5 VFS 모드 병합 스캔',
  'parsing-localization': '2/5 한글/영문 로컬라이제이션 파싱',
  'parsing-scripts': '3/5 Jomini 스크립트 파싱',
  'loading-embedder': '4/5 로컬 ONNX 임베딩 모델 로드',
  'embedding-vectors': '4/5 로컬 CPU 벡터 임베딩 생성',
  'committing-db': '5/5 SQLite + sqlite-vec 트랜잭션 저장',
  completed: '인덱싱 완료',
  cancelled: '인덱싱 취소됨',
  error: '인덱싱 오류'
}

export const AutoIndexBanner: React.FC<AutoIndexBannerProps> = ({
  versionCheck,
  indexProgress,
  isIndexing,
  dismissed,
  onStartIndexing,
  onCancelIndexing,
  onDismiss,
  onOpenSettings
}) => {
  const [showDetails, setShowDetails] = useState(false)

  const hasError = indexProgress?.phase === 'error'
  const shouldShow =
    isIndexing ||
    (hasError && !dismissed) ||
    Boolean(versionCheck && (versionCheck.needsReindex || !versionCheck.pathsValid) && !dismissed)

  if (!shouldShow) return null

  const diff = versionCheck?.diff

  const diffBadges = diff
    ? R.pipe(
        [
          ...diff.addedMods.slice(0, 6).map((m) => ({ label: `+ ${m}`, color: 'success' as const })),
          ...diff.updatedMods
            .slice(0, 6)
            .map((m) => ({ label: `↻ ${m}`, color: 'warning' as const })),
          ...diff.removedMods
            .slice(0, 4)
            .map((m) => ({ label: `- ${m}`, color: 'error' as const }))
        ],
        R.take(10)
      )
    : []

  return (
    <Box sx={{ width: '100%', maxWidth: 820, mx: 'auto', px: 2, mt: 0.5, zIndex: 5 }}>
      {isIndexing && indexProgress ? (
        <Paper
          elevation={0}
          sx={{
            p: 2,
            borderRadius: '10px',
            backgroundColor: ROYAL_COLORS.BG_PILL,
            border: `1px solid ${ROYAL_COLORS.GOLD_DIM}`
          }}
        >
          <Stack spacing={1.1}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip
                  size="small"
                  color="primary"
                  label={PHASE_LABELS[indexProgress.phase] || indexProgress.phase}
                />
                <Typography variant="body2" sx={{ color: ROYAL_COLORS.TEXT_PRIMARY }}>
                  {indexProgress.message}
                </Typography>
              </Stack>

              <Stack direction="row" spacing={1.25} alignItems="center">
                <Typography variant="caption" sx={{ fontWeight: 700, color: ROYAL_COLORS.GOLD_LIGHT }}>
                  {indexProgress.percent}%
                </Typography>
                <Button
                  size="small"
                  color="inherit"
                  variant="outlined"
                  startIcon={<StopCircleIcon fontSize="small" />}
                  onClick={onCancelIndexing}
                  sx={{ py: 0.25, fontSize: '0.75rem' }}
                >
                  중단
                </Button>
              </Stack>
            </Stack>

            <LinearProgress
              variant="determinate"
              value={indexProgress.percent}
              sx={{ height: 6, borderRadius: 999 }}
            />

            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography
                variant="caption"
                sx={{
                  color: ROYAL_COLORS.TEXT_SECONDARY,
                  maxWidth: '75%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {indexProgress.currentItem ? `처리 중: ${indexProgress.currentItem}` : '준비 중...'}
              </Typography>
              {indexProgress.totalCount > 0 && (
                <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                  {indexProgress.processedCount.toLocaleString()} /{' '}
                  {indexProgress.totalCount.toLocaleString()}
                </Typography>
              )}
            </Stack>
          </Stack>
        </Paper>
      ) : hasError && indexProgress ? (
        <Alert
          severity="error"
          sx={{ borderRadius: '10px' }}
          action={
            <Stack direction="row" spacing={1}>
              <Button color="inherit" size="small" onClick={onStartIndexing}>
                재시도
              </Button>
              <IconButton color="inherit" size="small" onClick={onDismiss}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
          }
        >
          <Typography variant="subtitle2">인덱싱 오류</Typography>
          <Typography variant="caption">{indexProgress.error || indexProgress.message}</Typography>
        </Alert>
      ) : versionCheck && !versionCheck.pathsValid ? (
        <Alert
          severity="warning"
          icon={<FolderOffIcon />}
          sx={{ borderRadius: '10px' }}
          action={
            <Button color="inherit" size="small" variant="outlined" onClick={onOpenSettings}>
              경로 설정
            </Button>
          }
        >
          <Typography variant="caption">{versionCheck.reasonSummary}</Typography>
        </Alert>
      ) : (
        <Paper
          elevation={0}
          sx={{
            px: 2.25,
            py: 1.35,
            borderRadius: '10px',
            backgroundColor: ROYAL_COLORS.BG_PILL,
            border: `1px solid ${ROYAL_COLORS.GOLD_DIM}`
          }}
        >
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            spacing={1.25}
          >
            <Box>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip
                  size="small"
                  label="인덱스 동기화 권장"
                  sx={{
                    height: 22,
                    fontSize: '0.72rem',
                    backgroundColor: 'rgba(212, 175, 90, 0.14)',
                    color: ROYAL_COLORS.GOLD_LIGHT
                  }}
                />
                <Typography variant="body2" sx={{ fontSize: '0.84rem' }}>
                  {versionCheck?.reasonSummary}
                </Typography>
                {diffBadges.length > 0 && (
                  <Button
                    size="small"
                    color="inherit"
                    endIcon={showDetails ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                    onClick={() => setShowDetails((prev) => !prev)}
                    sx={{ py: 0, px: 1, fontSize: '0.73rem', color: ROYAL_COLORS.TEXT_SECONDARY }}
                  >
                    상세 내역
                  </Button>
                )}
              </Stack>
            </Box>

            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexShrink: 0 }}>
              <Button
                variant="contained"
                color="primary"
                size="small"
                startIcon={<AutoFixHighIcon sx={{ fontSize: 16 }} />}
                onClick={onStartIndexing}
                sx={{ py: 0.5, fontSize: '0.78rem' }}
              >
                자동 인덱싱 시작
              </Button>
              <IconButton size="small" onClick={onDismiss} sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                <CloseIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Stack>
          </Stack>

          <Collapse in={showDetails}>
            <Stack
              direction="row"
              flexWrap="wrap"
              gap={0.65}
              sx={{ mt: 1.25, pt: 1, borderTop: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}` }}
            >
              {diffBadges.map((badge, idx) => (
                <Chip
                  key={`${badge.label}-${idx}`}
                  size="small"
                  label={badge.label}
                  color={badge.color}
                  variant="outlined"
                  sx={{ height: 22, fontSize: '0.72rem' }}
                />
              ))}
              {(diff?.addedMods.length ?? 0) > 6 && (
                <Chip
                  size="small"
                  label={`외 ${(diff?.addedMods.length ?? 0) - 6}개 모드`}
                  variant="outlined"
                  sx={{ height: 22, fontSize: '0.72rem' }}
                />
              )}
            </Stack>
          </Collapse>
        </Paper>
      )}
    </Box>
  )
}
