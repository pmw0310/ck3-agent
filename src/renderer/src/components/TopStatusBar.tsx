import React from 'react'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined'
import FileOpenOutlinedIcon from '@mui/icons-material/FileOpenOutlined'
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined'
import MenuOpenRoundedIcon from '@mui/icons-material/MenuOpenRounded'
import MenuRoundedIcon from '@mui/icons-material/MenuRounded'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import VerifiedIcon from '@mui/icons-material/Verified'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined'
import MonetizationOnOutlinedIcon from '@mui/icons-material/MonetizationOnOutlined'
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined'
import * as R from 'remeda'
import type { SaveProgressPayload, SaveSummary, VersionCheckResult } from '@shared/types'
import { FONT_FAMILIES, ROYAL_COLORS } from '@renderer/theme'
import appIconUrl from '@renderer/assets/app-icon.png?inline'

export interface TopStatusBarProps {
  sidebarOpen: boolean
  saveSummary: SaveSummary | null
  saveProgress: SaveProgressPayload | null
  isSaveLoading: boolean
  versionCheck: VersionCheckResult | null
  hasMessages: boolean
  onToggleSidebar: () => void
  onNewChat: () => void
  onLoadLatestSave: () => void
  onSelectSaveFile: () => void
  onOpenSettings: () => void
}

export const TopStatusBar: React.FC<TopStatusBarProps> = ({
  sidebarOpen,
  saveSummary,
  saveProgress,
  isSaveLoading,
  versionCheck,
  hasMessages,
  onToggleSidebar,
  onNewChat,
  onLoadLatestSave,
  onSelectSaveFile,
  onOpenSettings
}) => {
  const activeModCount = versionCheck?.currentSnapshot.enabledMods.length ?? 0
  const baseVerLabel = versionCheck?.currentSnapshot.rawGameVersion || '미확인'
  const isSynced = Boolean(versionCheck && !versionCheck.needsReindex && versionCheck.pathsValid)

  const rulerTooltipContent = saveSummary ? (
    <Box sx={{ p: 0.5, maxWidth: 360 }}>
      <Typography
        variant="subtitle2"
        sx={{ fontFamily: FONT_FAMILIES.MYEONGJO, color: ROYAL_COLORS.GOLD_LIGHT, mb: 0.5 }}
      >
        {saveSummary.playerName} · {saveSummary.age}세 · {saveSummary.houseName || '무소속 가문'}
      </Typography>
      <Typography variant="caption" display="block" sx={{ mb: 0.75 }}>
        문화: {saveSummary.cultureName || '-'} | 신앙: {saveSummary.faithName || '-'} | 정부:{' '}
        {saveSummary.governmentType || '-'}
      </Typography>
      <Typography variant="caption" display="block" sx={{ mb: 0.75 }}>
        능력치 — 외교 {saveSummary.skills.diplomacy} · 무력 {saveSummary.skills.martial} · 관리{' '}
        {saveSummary.skills.stewardship} · 계략 {saveSummary.skills.intrigue} · 학습{' '}
        {saveSummary.skills.learning} · 기량 {saveSummary.skills.prowess}
      </Typography>
      <Typography variant="caption" display="block" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
        트레잇: {R.pipe(saveSummary.traits, R.take(8)).join(', ') || '정보 없음'}
      </Typography>
      <Divider sx={{ my: 0.75 }} />
      <Typography variant="caption" display="block" sx={{ opacity: 0.8 }}>
        파일: {saveSummary.fileName}
      </Typography>
    </Box>
  ) : (
    '로드된 세이브가 없습니다. 우측 [최신 세이브 불러오기]를 눌러 분석을 시작하세요.'
  )

  const versionTooltipContent = versionCheck ? (
    <Box sx={{ p: 0.5, maxWidth: 340 }}>
      <Typography variant="subtitle2" sx={{ color: ROYAL_COLORS.GOLD_LIGHT }}>
        본편 버전: {versionCheck.currentSnapshot.baseGameVersion}
      </Typography>
      <Typography variant="caption" display="block">
        활성 플레이세트: {versionCheck.currentSnapshot.activePlaysetName}
      </Typography>
      <Typography variant="caption" display="block">
        활성 모드: {activeModCount}개 · 해시 {versionCheck.currentSnapshot.fingerprintHash}
      </Typography>
      <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
        인덱싱 현황: 스크립트 {versionCheck.indexedScriptCount.toLocaleString()}건 · 로컬라이제이션{' '}
        {versionCheck.indexedLocCount.toLocaleString()}건
      </Typography>
    </Box>
  ) : (
    '버전 및 모드 정보를 확인하는 중입니다...'
  )

  return (
    <Box
      component="header"
      sx={{
        minHeight: 60,
        px: 2.25,
        py: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.25,
        flexWrap: 'nowrap',
        overflow: 'hidden',
        zIndex: 10
      }}
    >
      {/* Left: Sidebar Toggle + Brand + Version Pill + New Chat */}
      <Stack direction="row" spacing={1.1} alignItems="center" sx={{ flexShrink: 0 }}>
        <Tooltip title={sidebarOpen ? '채팅 목록 접기' : '채팅 목록 펼치기'} arrow>
          <IconButton
            size="small"
            onClick={onToggleSidebar}
            sx={{
              width: 34,
              height: 34,
              color: ROYAL_COLORS.TEXT_SECONDARY,
              backgroundColor: ROYAL_COLORS.BG_PILL,
              border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
              '&:hover': { backgroundColor: ROYAL_COLORS.BG_PILL_HOVER, color: '#FFF' }
            }}
          >
            {sidebarOpen ? (
              <MenuOpenRoundedIcon sx={{ fontSize: 19 }} />
            ) : (
              <MenuRoundedIcon sx={{ fontSize: 19 }} />
            )}
          </IconButton>
        </Tooltip>

        <Box
          component="img"
          src={appIconUrl}
          alt="CK3 제미나이 에이전트"
          sx={{
            width: 30,
            height: 30,
            display: 'block',
            filter: 'drop-shadow(0 2px 8px rgba(212, 175, 90, 0.24))'
          }}
        />
        <Typography
          sx={{
            fontFamily: FONT_FAMILIES.MYEONGJO,
            fontSize: '1.08rem',
            fontWeight: 700,
            color: ROYAL_COLORS.TEXT_PRIMARY,
            letterSpacing: '-0.01em'
          }}
        >
          CK3 제미나이 에이전트
        </Typography>

        <Tooltip title={versionTooltipContent} arrow>
          <Chip
            size="small"
            icon={
              isSynced ? (
                <VerifiedIcon sx={{ fontSize: '14px !important', color: '#5BB98B !important' }} />
              ) : (
                <WarningAmberRoundedIcon
                  sx={{ fontSize: '14px !important', color: '#E2A84B !important' }}
                />
              )
            }
            label={`v${baseVerLabel} · 모드 ${activeModCount}`}
            sx={{
              height: 26,
              fontSize: '0.75rem',
              backgroundColor: ROYAL_COLORS.BG_PILL,
              color: ROYAL_COLORS.TEXT_SECONDARY,
              border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`
            }}
          />
        </Tooltip>

        {hasMessages && (
          <Tooltip title="새 대화 시작" arrow>
            <IconButton
              size="small"
              onClick={onNewChat}
              sx={{
                color: ROYAL_COLORS.TEXT_SECONDARY,
                backgroundColor: ROYAL_COLORS.BG_PILL,
                border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
                '&:hover': { backgroundColor: ROYAL_COLORS.BG_PILL_HOVER, color: '#FFF' }
              }}
            >
              <AddCommentOutlinedIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* Center: Sleek Save Pill */}
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center' }}>
        {isSaveLoading ? (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{
              px: 1.75,
              py: 0.55,
              maxWidth: '100%',
              borderRadius: '8px',
              backgroundColor: ROYAL_COLORS.BG_PILL,
              border: `1px solid ${ROYAL_COLORS.GOLD_DIM}`
            }}
          >
            <CircularProgress size={14} color="primary" sx={{ flexShrink: 0 }} />
            <Typography
              variant="caption"
              sx={{
                color: ROYAL_COLORS.GOLD_LIGHT,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {saveProgress?.message || '세이브 분석 중...'}
              {saveProgress ? ` · ${saveProgress.percent}%` : ''}
            </Typography>
          </Stack>
        ) : saveSummary ? (
          <Tooltip title={rulerTooltipContent} arrow>
            <Stack
              direction="row"
              spacing={1.15}
              alignItems="center"
              divider={<Divider orientation="vertical" flexItem sx={{ my: 0.6 }} />}
              sx={{
                px: 1.5,
                py: 0.5,
                maxWidth: '100%',
                minWidth: 0,
                borderRadius: '8px',
                backgroundColor: ROYAL_COLORS.BG_PILL,
                border: `1px solid ${ROYAL_COLORS.GOLD_DIM}`,
                cursor: 'help',
                transition: 'background-color 0.15s ease',
                '&:hover': { backgroundColor: ROYAL_COLORS.BG_PILL_HOVER }
              }}
            >
              <Stack
                direction="row"
                spacing={0.75}
                alignItems="baseline"
                sx={{ minWidth: 0, overflow: 'hidden' }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: FONT_FAMILIES.MYEONGJO,
                    fontWeight: 700,
                    color: '#FFFFFF',
                    fontSize: '0.86rem',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 160
                  }}
                >
                  {saveSummary.playerName}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: ROYAL_COLORS.GOLD_LIGHT,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {saveSummary.primaryTitleName || saveSummary.primaryTitleKey} ·{' '}
                  {saveSummary.gameDate}년
                </Typography>
              </Stack>

              <Stack direction="row" spacing={1.05} alignItems="center" sx={{ flexShrink: 0 }}>
                <Stack direction="row" spacing={0.35} alignItems="center">
                  <MonetizationOnOutlinedIcon sx={{ fontSize: 15, color: ROYAL_COLORS.GOLD_LIGHT }} />
                  <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_PRIMARY }}>
                    {Math.round(saveSummary.gold).toLocaleString()}
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={0.35} alignItems="center">
                  <ShieldOutlinedIcon sx={{ fontSize: 15, color: '#E07A7A' }} />
                  <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_PRIMARY }}>
                    {saveSummary.militaryStrength.toLocaleString()}
                  </Typography>
                </Stack>

                {(saveSummary.activeWarCount > 0 || saveSummary.dangerousFactionCount > 0) && (
                  <Stack direction="row" spacing={0.35} alignItems="center">
                    <GroupsOutlinedIcon sx={{ fontSize: 15, color: '#E2A84B' }} />
                    <Typography variant="caption" sx={{ color: '#E2A84B', fontWeight: 700 }}>
                      전쟁 {saveSummary.activeWarCount} · 파벌 {saveSummary.dangerousFactionCount}
                    </Typography>
                  </Stack>
                )}
              </Stack>
            </Stack>
          </Tooltip>
        ) : null}
      </Box>

      {/* Right: Gemini-style Pill Actions */}
      <Stack direction="row" spacing={0.85} alignItems="center" sx={{ flexShrink: 0 }}>
        <Button
          size="small"
          startIcon={<FileOpenOutlinedIcon sx={{ fontSize: 17, color: ROYAL_COLORS.GOLD_LIGHT }} />}
          disabled={isSaveLoading}
          onClick={onLoadLatestSave}
          sx={{
            py: 0.65,
            px: 1.8,
            fontSize: '0.8rem',
            color: ROYAL_COLORS.TEXT_PRIMARY,
            backgroundColor: ROYAL_COLORS.BG_PILL,
            border: `1px solid ${ROYAL_COLORS.GOLD_DIM}`,
            '&:hover': {
              backgroundColor: ROYAL_COLORS.BG_PILL_HOVER,
              borderColor: ROYAL_COLORS.GOLD_MAIN
            }
          }}
        >
          최신 세이브 불러오기
        </Button>

        <Tooltip title="다른 .ck3 세이브 파일 직접 선택" arrow>
          <span>
            <IconButton
              size="small"
              onClick={onSelectSaveFile}
              disabled={isSaveLoading}
              sx={{
                width: 34,
                height: 34,
                color: ROYAL_COLORS.TEXT_SECONDARY,
                backgroundColor: ROYAL_COLORS.BG_PILL,
                border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
                '&:hover': { backgroundColor: ROYAL_COLORS.BG_PILL_HOVER, color: '#FFF' }
              }}
            >
              <FolderOpenOutlinedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="환경설정" arrow>
          <IconButton
            size="small"
            onClick={onOpenSettings}
            sx={{
              width: 34,
              height: 34,
              color: ROYAL_COLORS.TEXT_SECONDARY,
              backgroundColor: ROYAL_COLORS.BG_PILL,
              border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`,
              '&:hover': { backgroundColor: ROYAL_COLORS.BG_PILL_HOVER, color: '#FFF' }
            }}
          >
            <SettingsOutlinedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  )
}
