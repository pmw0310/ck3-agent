import React, { useEffect, useState, useSyncExternalStore } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import KeyIcon from '@mui/icons-material/Key'
import LockIcon from '@mui/icons-material/Lock'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import RefreshIcon from '@mui/icons-material/Refresh'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import TravelExploreIcon from '@mui/icons-material/TravelExplore'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined'
import * as R from 'remeda'
import {
  DEFAULT_EDGE_TTS_RATE,
  DEFAULT_EDGE_TTS_VOICE,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  EDGE_TTS_RATE_OPTIONS,
  EDGE_TTS_VOICE_OPTIONS,
  FALLBACK_GEMINI_MODELS,
  GEMINI_TTS_MODEL_OPTIONS,
  GEMINI_TTS_VOICE_OPTIONS
} from '@shared/constants'
import type {
  EdgeTtsVoice,
  GeminiModelOption,
  GeminiTtsModel,
  GeminiTtsVoice,
  PublicAppSettings,
  TtsProvider,
  UpdateSettingsPayload,
  VersionCheckResult
} from '@shared/types'
import { FONT_FAMILIES, ROYAL_COLORS } from '@renderer/theme'
import {
  getTtsPlaybackSnapshot,
  playTtsForText,
  stopTtsPlayback,
  subscribeTtsPlayback
} from '@renderer/utils/ttsPlayer'

export interface SettingsDialogProps {
  open: boolean
  settings: PublicAppSettings | null
  versionCheck: VersionCheckResult | null
  isIndexing: boolean
  onClose: () => void
  onSaveSettings: (payload: UpdateSettingsPayload) => Promise<void>
  onForceReindex: () => Promise<void>
  onNotify: (message: string, severity?: 'success' | 'info' | 'warning' | 'error') => void
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  settings,
  versionCheck,
  isIndexing,
  onClose,
  onSaveSettings,
  onForceReindex,
  onNotify
}) => {
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [clearStoredKey, setClearStoredKey] = useState(false)
  const [selectedModel, setSelectedModel] = useState(DEFAULT_GEMINI_MODEL)
  const [documentsDir, setDocumentsDir] = useState('')
  const [steamInstallDir, setSteamInstallDir] = useState('')
  const [workshopDir, setWorkshopDir] = useState('')
  const [autoCheckStartup, setAutoCheckStartup] = useState(true)
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>('edge')
  const [edgeTtsVoice, setEdgeTtsVoice] = useState<EdgeTtsVoice>(DEFAULT_EDGE_TTS_VOICE)
  const [edgeTtsRate, setEdgeTtsRate] = useState<string>(DEFAULT_EDGE_TTS_RATE)
  const [geminiTtsModel, setGeminiTtsModel] = useState<GeminiTtsModel>(DEFAULT_GEMINI_TTS_MODEL)
  const [geminiTtsVoice, setGeminiTtsVoice] = useState<GeminiTtsVoice>(DEFAULT_GEMINI_TTS_VOICE)
  const [autoPlayTts, setAutoPlayTts] = useState(false)
  const [modelOptions, setModelOptions] = useState<GeminiModelOption[]>(FALLBACK_GEMINI_MODELS)
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const ttsSnapshot = useSyncExternalStore(subscribeTtsPlayback, getTtsPlaybackSnapshot)
  const isPreviewActive = ttsSnapshot.activeId === 'settings-tts-preview'

  useEffect(() => {
    if (open && settings) {
      setApiKeyInput('')
      setClearStoredKey(false)
      setSelectedModel(settings.config.selectedModel)
      setDocumentsDir(settings.config.documentsDir)
      setSteamInstallDir(settings.config.steamInstallDir)
      setWorkshopDir(settings.config.workshopDir)
      setAutoCheckStartup(settings.config.autoCheckVersionOnStartup)
      setTtsProvider(settings.config.ttsProvider || 'edge')
      setEdgeTtsVoice(settings.config.edgeTtsVoice || DEFAULT_EDGE_TTS_VOICE)
      setEdgeTtsRate(settings.config.edgeTtsRate || DEFAULT_EDGE_TTS_RATE)
      setGeminiTtsModel(settings.config.geminiTtsModel || DEFAULT_GEMINI_TTS_MODEL)
      setGeminiTtsVoice(settings.config.geminiTtsVoice || DEFAULT_GEMINI_TTS_VOICE)
      setAutoPlayTts(Boolean(settings.config.autoPlayTts))

      if (settings.hasApiKey) {
        void handleFetchModels('')
      }
    }
  }, [open, settings])

  const handleFetchModels = async (overrideKey: string): Promise<void> => {
    setLoadingModels(true)
    try {
      const models = await window.ck3Api.listGeminiModels(overrideKey || undefined)
      const merged = R.pipe(
        [...models, ...FALLBACK_GEMINI_MODELS],
        R.uniqueBy((m) => m.id)
      )
      setModelOptions(merged)
      if (overrideKey) {
        onNotify(`사용 가능한 Gemini 모델 ${models.length}개를 불러왔습니다.`, 'success')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onNotify(`모델 목록 조회 실패: ${msg}`, 'warning')
    } finally {
      setLoadingModels(false)
    }
  }

  const handleAutoDetectPaths = async (): Promise<void> => {
    const detected = await window.ck3Api.autoDetectPaths()
    setDocumentsDir(detected.documentsDir)
    setSteamInstallDir(detected.steamInstallDir)
    setWorkshopDir(detected.workshopDir)
    onNotify('CK3 문서 폴더 및 Steam 설치/창작마당 경로를 자동 탐색했습니다.', 'info')
  }

  const handleBrowseFolder = async (
    title: string,
    currentVal: string,
    setter: (val: string) => void
  ): Promise<void> => {
    const picked = await window.ck3Api.selectDirectory(title, currentVal)
    if (picked) setter(picked)
  }

  const handlePreviewVoice = (): void => {
    void playTtsForText({
      id: 'settings-tts-preview',
      markdownText: '폐하, 현재 왕국의 국고와 봉신들의 동향을 정리하여 보고드립니다.',
      overrides: {
        providerOverride: ttsProvider,
        edgeVoiceOverride: edgeTtsVoice,
        edgeRateOverride: edgeTtsRate,
        geminiModelOverride: geminiTtsModel,
        geminiVoiceOverride: geminiTtsVoice
      },
      onFallbackNotice: (reason) => onNotify(reason, 'info'),
      onError: (errMsg) => onNotify(errMsg, 'warning')
    })
  }

  const handleSave = async (): Promise<void> => {
    stopTtsPlayback()
    setSaving(true)
    try {
      await onSaveSettings({
        documentsDir: documentsDir.trim(),
        steamInstallDir: steamInstallDir.trim(),
        workshopDir: workshopDir.trim(),
        selectedModel: selectedModel.trim() || DEFAULT_GEMINI_MODEL,
        autoCheckVersionOnStartup: autoCheckStartup,
        ttsProvider,
        edgeTtsVoice,
        edgeTtsRate,
        geminiTtsModel,
        geminiTtsVoice,
        autoPlayTts,
        apiKey: apiKeyInput.trim() || undefined,
        clearApiKey: clearStoredKey
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        stopTtsPlayback()
        onClose()
      }}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle
        sx={{
          pb: 1.25,
          fontFamily: FONT_FAMILIES.MYEONGJO,
          color: ROYAL_COLORS.GOLD_LIGHT,
          fontWeight: 700
        }}
      >
        환경설정 — API 키 · 모델 · 음성 낭독 · CK3 경로
      </DialogTitle>

      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {/* Section 1: BYOK Gemini API Key */}
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <KeyIcon sx={{ fontSize: 18, color: ROYAL_COLORS.GOLD_MAIN }} />
            <Typography variant="subtitle2">Gemini API 키</Typography>
            {settings?.encryptionAvailable && (
              <Chip
                size="small"
                icon={<LockIcon sx={{ fontSize: 13 }} />}
                label="OS 암호화 저장 활성"
                color="success"
                variant="outlined"
              />
            )}
          </Stack>

          {settings?.hasApiKey && !clearStoredKey && (
            <Alert
              severity="success"
              sx={{ mb: 1.25, py: 0.25 }}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => setClearStoredKey(true)}
                >
                  저장된 키 삭제
                </Button>
              }
            >
              저장된 암호화 API 키: <strong>{settings.maskedApiKey}</strong> · 새 키를 입력하면 교체됩니다
            </Alert>
          )}

          {clearStoredKey && (
            <Alert severity="warning" sx={{ mb: 1.25, py: 0.25 }}>
              설정 저장을 누르면 기존 API 키가 삭제됩니다.
            </Alert>
          )}

          <TextField
            fullWidth
            size="small"
            type={showApiKey ? 'text' : 'password'}
            label="Google AI Studio API 키"
            placeholder="AIzaSy..."
            value={apiKeyInput}
            onChange={(e) => {
              setApiKeyInput(e.target.value)
              if (e.target.value.trim()) setClearStoredKey(false)
            }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={() => setShowApiKey((prev) => !prev)}
                      edge="end"
                    >
                      {showApiKey ? (
                        <VisibilityOffIcon fontSize="small" />
                      ) : (
                        <VisibilityIcon fontSize="small" />
                      )}
                    </IconButton>
                  </InputAdornment>
                )
              }
            }}
          />
        </Box>

        <Divider />

        {/* Section 2: Dynamic Gemini Model Selection (freeSolo) */}
        <Box>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{ mb: 1 }}
          >
            <Typography variant="subtitle2">추론 모델</Typography>
            <Button
              size="small"
              variant="outlined"
              disabled={loadingModels}
              startIcon={
                loadingModels ? <CircularProgress size={14} /> : <RefreshIcon fontSize="small" />
              }
              onClick={() => void handleFetchModels(apiKeyInput.trim())}
            >
              모델 목록 새로고침
            </Button>
          </Stack>

          <Autocomplete
            freeSolo
            options={modelOptions.map((opt) => opt.id)}
            value={selectedModel}
            inputValue={selectedModel}
            onChange={(_e, newValue) => {
              setSelectedModel(newValue ?? '')
            }}
            onInputChange={(_e, newInputValue, reason) => {
              if (reason === 'input' || reason === 'clear') {
                setSelectedModel(newInputValue)
              }
            }}
            renderOption={(props, optionId) => {
              const { key, ...optionProps } = props
              const found = modelOptions.find((m) => m.id === optionId)
              return (
                <Box component="li" key={key} {...optionProps}>
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {found?.displayName || optionId}
                    </Typography>
                    {found?.description && (
                      <Typography
                        variant="caption"
                        sx={{ color: ROYAL_COLORS.TEXT_SECONDARY, display: 'block' }}
                      >
                        {found.description.slice(0, 110)}
                      </Typography>
                    )}
                  </Box>
                </Box>
              )
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                size="small"
                label="사용할 Gemini 모델"
                helperText="목록에서 선택하거나 모델 ID를 직접 입력할 수 있습니다 · 기본 제공: gemini-3.8-flash, gemini-4-hydrogen, gemini-4-argon, gemini-4-carbon"
              />
            )}
          />
        </Box>

        <Divider />

        {/* Section 2.5: Dual TTS Settings (Free Edge TTS & Gemini TTS Only) */}
        <Box>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{ mb: 1.25 }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <VolumeUpOutlinedIcon sx={{ fontSize: 18, color: ROYAL_COLORS.GOLD_MAIN }} />
              <Typography variant="subtitle2">음성 낭독 설정</Typography>
            </Stack>

            <Button
              size="small"
              variant="outlined"
              startIcon={
                isPreviewActive ? (
                  ttsSnapshot.status === 'loading' ? (
                    <CircularProgress size={14} />
                  ) : (
                    <StopRoundedIcon fontSize="small" />
                  )
                ) : (
                  <PlayArrowRoundedIcon fontSize="small" />
                )
              }
              onClick={handlePreviewVoice}
            >
              {isPreviewActive ? '미리듣기 중지' : '음성 미리듣기'}
            </Button>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
            <Button
              fullWidth
              variant={ttsProvider === 'edge' ? 'contained' : 'outlined'}
              color={ttsProvider === 'edge' ? 'primary' : 'inherit'}
              onClick={() => setTtsProvider('edge')}
              sx={{ py: 0.75 }}
            >
              무료 음성 · Edge 신경망
            </Button>
            <Button
              fullWidth
              variant={ttsProvider === 'gemini' ? 'contained' : 'outlined'}
              color={ttsProvider === 'gemini' ? 'primary' : 'inherit'}
              onClick={() => setTtsProvider('gemini')}
              sx={{ py: 0.75 }}
            >
              제미나이 음성 · Gemini TTS
            </Button>
          </Stack>

          {ttsProvider === 'edge' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                select
                fullWidth
                size="small"
                label="무료 음성 성우"
                value={edgeTtsVoice}
                onChange={(e) => setEdgeTtsVoice(e.target.value as EdgeTtsVoice)}
                helperText="API 키나 과금 없이 무료로 동작하는 한국어 신경망 음성입니다"
              >
                {EDGE_TTS_VOICE_OPTIONS.map((opt) => (
                  <MenuItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                select
                fullWidth
                size="small"
                label="낭독 속도"
                value={edgeTtsRate}
                onChange={(e) => setEdgeTtsRate(e.target.value)}
              >
                {EDGE_TTS_RATE_OPTIONS.map((opt) => (
                  <MenuItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          ) : (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                select
                fullWidth
                size="small"
                label="제미나이 TTS 모델"
                value={geminiTtsModel}
                onChange={(e) => setGeminiTtsModel(e.target.value as GeminiTtsModel)}
                helperText="등록된 Gemini API 키를 그대로 사용하며 동일 문장은 로컬 캐시로 재생됩니다"
              >
                {GEMINI_TTS_MODEL_OPTIONS.map((opt) => (
                  <MenuItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                select
                fullWidth
                size="small"
                label="제미나이 성우"
                value={geminiTtsVoice}
                onChange={(e) => setGeminiTtsVoice(e.target.value as GeminiTtsVoice)}
              >
                {GEMINI_TTS_VOICE_OPTIONS.map((opt) => (
                  <MenuItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          )}

          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1 }}>
            <Switch
              size="small"
              checked={autoPlayTts}
              onChange={(e) => setAutoPlayTts(e.target.checked)}
            />
            <Typography variant="caption">
              에이전트 답변 생성이 완료되면 자동으로 음성 낭독 시작
            </Typography>
          </Stack>
        </Box>

        <Divider />

        {/* Section 3: CK3 Directory Paths */}
        <Box>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{ mb: 1.25 }}
          >
            <Typography variant="subtitle2">Crusader Kings III 및 창작마당 경로</Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<TravelExploreIcon fontSize="small" />}
              onClick={() => void handleAutoDetectPaths()}
            >
              경로 자동 탐색
            </Button>
          </Stack>

          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1}>
              <TextField
                fullWidth
                size="small"
                label="CK3 문서 폴더"
                value={documentsDir}
                onChange={(e) => setDocumentsDir(e.target.value)}
              />
              <Tooltip title="폴더 선택" arrow>
                <Button
                  variant="outlined"
                  onClick={() =>
                    void handleBrowseFolder('CK3 문서 폴더 선택', documentsDir, setDocumentsDir)
                  }
                >
                  <FolderOpenIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Stack>

            <Stack direction="row" spacing={1}>
              <TextField
                fullWidth
                size="small"
                label="CK3 게임 설치 폴더"
                value={steamInstallDir}
                onChange={(e) => setSteamInstallDir(e.target.value)}
              />
              <Tooltip title="폴더 선택" arrow>
                <Button
                  variant="outlined"
                  onClick={() =>
                    void handleBrowseFolder(
                      'CK3 설치 폴더 선택',
                      steamInstallDir,
                      setSteamInstallDir
                    )
                  }
                >
                  <FolderOpenIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Stack>

            <Stack direction="row" spacing={1}>
              <TextField
                fullWidth
                size="small"
                label="Steam 창작마당 폴더"
                value={workshopDir}
                onChange={(e) => setWorkshopDir(e.target.value)}
              />
              <Tooltip title="폴더 선택" arrow>
                <Button
                  variant="outlined"
                  onClick={() =>
                    void handleBrowseFolder(
                      '창작마당 1158310 폴더 선택',
                      workshopDir,
                      setWorkshopDir
                    )
                  }
                >
                  <FolderOpenIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Stack>
          </Stack>
        </Box>

        <Divider />

        {/* Section 4: Portable Data Storage & Force Re-index */}
        <Box>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            spacing={1.5}
          >
            <Box>
              <Typography variant="subtitle2">포터블 데이터 격리 저장소 & 인덱스 관리</Typography>
              <Typography variant="caption" display="block" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                격리 데이터 경로: {settings?.dataDir || './data'}
              </Typography>
              <Typography variant="caption" display="block" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                현재 적재량: 스크립트{' '}
                {(versionCheck?.indexedScriptCount ?? 0).toLocaleString()}건 · 로컬라이제이션{' '}
                {(versionCheck?.indexedLocCount ?? 0).toLocaleString()}건
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                <Switch
                  size="small"
                  checked={autoCheckStartup}
                  onChange={(e) => setAutoCheckStartup(e.target.checked)}
                />
                <Typography variant="caption">
                  앱 시작 시 게임 버전 및 플레이세트 해시 자동 검증
                </Typography>
              </Stack>
            </Box>

            <Button
              variant="outlined"
              color="warning"
              disabled={isIndexing}
              startIcon={<AutoFixHighIcon />}
              onClick={() => {
                void onForceReindex()
                onClose()
              }}
            >
              강제 전체 재인덱싱
            </Button>
          </Stack>
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button color="inherit" onClick={onClose}>
          취소
        </Button>
        <Button variant="contained" color="primary" disabled={saving} onClick={() => void handleSave()}>
          설정 저장
        </Button>
      </DialogActions>
    </Dialog>
  )
}
