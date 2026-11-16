import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Snackbar } from '@mui/material'
import * as R from 'remeda'
import { DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODELS } from '@shared/constants'
import type {
  ChatMessage,
  ChatMode,
  ChatSession,
  GeminiModelOption,
  IndexProgressPayload,
  PublicAppSettings,
  SaveProgressPayload,
  SaveSummary,
  ToolExecutionStep,
  UpdateSettingsPayload,
  VersionCheckResult
} from '@shared/types'
import { TopStatusBar } from '@renderer/components/TopStatusBar'
import { AutoIndexBanner } from '@renderer/components/AutoIndexBanner'
import { ChatArea } from '@renderer/components/ChatArea'
import { ChatSidebar } from '@renderer/components/ChatSidebar'
import { SettingsDialog } from '@renderer/components/SettingsDialog'
import { ROYAL_COLORS } from '@renderer/theme'
import { playTtsForText, stopTtsPlayback } from '@renderer/utils/ttsPlayer'

interface ToastState {
  open: boolean
  message: string
  severity: 'success' | 'info' | 'warning' | 'error'
}

const deriveSessionTitle = (firstPrompt: string): string => {
  const normalized = firstPrompt.replace(/\s+/g, ' ').trim()
  if (!normalized) return '새 대화'
  return normalized.length > 30 ? `${normalized.slice(0, 30)}…` : normalized
}

export const App: React.FC = () => {
  const [settings, setSettings] = useState<PublicAppSettings | null>(null)
  const [availableModels, setAvailableModels] = useState<GeminiModelOption[]>(
    FALLBACK_GEMINI_MODELS
  )
  const [versionCheck, setVersionCheck] = useState<VersionCheckResult | null>(null)
  const [indexProgress, setIndexProgress] = useState<IndexProgressPayload | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  const [saveSummary, setSaveSummary] = useState<SaveSummary | null>(null)
  const [saveProgress, setSaveProgress] = useState<SaveProgressPayload | null>(null)
  const [isSaveLoading, setIsSaveLoading] = useState(false)

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [chatMode, setChatMode] = useState<ChatMode>('save_analysis')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [liveToolSteps, setLiveToolSteps] = useState<ToolExecutionStep[]>([])
  const [streamingReplyText, setStreamingReplyText] = useState<string>('')
  const activeRequestIdRef = useRef<string>('')
  const [isSending, setIsSending] = useState(false)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<ToastState>({
    open: false,
    message: '',
    severity: 'info'
  })

  const showToast = useCallback(
    (message: string, severity: ToastState['severity'] = 'info'): void => {
      setToast({ open: true, message, severity })
    },
    []
  )

  useEffect(() => {
    const bootstrap = async (): Promise<void> => {
      try {
        const [loadedSettings, existingSave, vCheck, storedSessions] = await Promise.all([
          window.ck3Api.getSettings(),
          window.ck3Api.getCurrentSaveSummary(),
          window.ck3Api.checkVersion(),
          window.ck3Api.listChatSessions()
        ])
        setSettings(loadedSettings)
        setSaveSummary(existingSave)
        setVersionCheck(vCheck)
        setSessions(storedSessions)

        if (!existingSave) {
          setChatMode('general_advisor')
        }

        if (loadedSettings.hasApiKey) {
          window.ck3Api
            .listGeminiModels()
            .then((models) => {
              if (models.length > 0) setAvailableModels(models)
            })
            .catch(() => undefined)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        showToast(`초기화 중 오류 발생: ${msg}`, 'error')
      }
    }

    void bootstrap()

    const unsubVersion = window.ck3Api.onVersionCheckResult((result) => {
      setVersionCheck(result)
      if (result.needsReindex) {
        setBannerDismissed(false)
      }
    })

    const unsubIndex = window.ck3Api.onIndexProgress((progress) => {
      setIndexProgress(progress)
      if (progress.phase === 'completed') {
        setIsIndexing(false)
        showToast(progress.message, 'success')
      } else if (progress.phase === 'cancelled') {
        setIsIndexing(false)
        showToast('인덱싱 작업이 취소되었습니다.', 'info')
      } else if (progress.phase === 'error') {
        setIsIndexing(false)
        showToast(progress.error || progress.message, 'error')
      } else {
        setIsIndexing(true)
      }
    })

    const unsubSave = window.ck3Api.onSaveProgress((progress) => {
      setSaveProgress(progress)
    })

    const unsubToolStep = window.ck3Api.onAgentToolStep((event) => {
      if (!activeRequestIdRef.current || activeRequestIdRef.current === event.requestId) {
        setLiveToolSteps((prev) => {
          const existingIdx = prev.findIndex((s) => s.id === event.step.id)
          if (existingIdx >= 0) {
            const cloned = [...prev]
            cloned[existingIdx] = event.step
            return cloned
          }
          return [...prev, event.step]
        })
      }
    })

    const unsubStreamChunk = window.ck3Api.onAgentStreamChunk((event) => {
      if (activeRequestIdRef.current && activeRequestIdRef.current === event.requestId) {
        setStreamingReplyText(event.accumulatedText)
      }
    })

    return () => {
      unsubVersion()
      unsubIndex()
      unsubSave()
      unsubToolStep()
      unsubStreamChunk()
    }
  }, [showToast])

  const handleStartIndexing = async (force = false): Promise<void> => {
    setBannerDismissed(false)
    const res = await window.ck3Api.startIndexing(force)
    if (!res.started) {
      showToast(res.message, 'warning')
      return
    }
    setIsIndexing(true)
    setIndexProgress({
      phase: 'scanning-vfs',
      percent: 1,
      message: res.message,
      processedCount: 0,
      totalCount: 0
    })
  }

  const handleCancelIndexing = async (): Promise<void> => {
    await window.ck3Api.cancelIndexing()
  }

  const handleLoadLatestSave = async (): Promise<void> => {
    setIsSaveLoading(true)
    setSaveProgress({
      phase: 'extracting',
      percent: 2,
      message: '최신 세이브 파일 탐색 중...',
      processedCount: 0,
      totalCount: 0
    })
    try {
      const result = await window.ck3Api.loadLatestSave()
      if (result.success && result.summary) {
        setSaveSummary(result.summary)
        setChatMode('save_analysis')
        showToast(
          `${result.summary.playerName} · ${result.summary.gameDate}년 세이브를 불러왔습니다.`,
          'success'
        )
      } else {
        showToast(result.error || '세이브 파일을 불러오지 못했습니다.', 'warning')
      }
    } finally {
      setIsSaveLoading(false)
      setSaveProgress(null)
    }
  }

  const handleSelectSaveFile = async (): Promise<void> => {
    const pickedPath = await window.ck3Api.selectSaveFile()
    if (!pickedPath) return

    setIsSaveLoading(true)
    setSaveProgress({
      phase: 'extracting',
      percent: 2,
      message: '선택한 세이브 파일 분석 준비 중...',
      processedCount: 0,
      totalCount: 0
    })
    try {
      const result = await window.ck3Api.loadSaveByPath(pickedPath)
      if (result.success && result.summary) {
        setSaveSummary(result.summary)
        setChatMode('save_analysis')
        showToast(
          `${result.summary.playerName} · ${result.summary.gameDate}년 세이브를 불러왔습니다.`,
          'success'
        )
      } else {
        showToast(result.error || '세이브 파싱 실패', 'error')
      }
    } finally {
      setIsSaveLoading(false)
      setSaveProgress(null)
    }
  }

  const handleSaveSettings = async (payload: UpdateSettingsPayload): Promise<void> => {
    const updated = await window.ck3Api.updateSettings(payload)
    setSettings(updated)
    if (updated.hasApiKey) {
      window.ck3Api
        .listGeminiModels()
        .then((models) => {
          if (models.length > 0) setAvailableModels(models)
        })
        .catch(() => undefined)
    }
    showToast('환경설정이 저장되었습니다.', 'success')
  }

  const handleQuickSelectModel = async (modelId: string): Promise<void> => {
    const updated = await window.ck3Api.updateSettings({ selectedModel: modelId })
    setSettings(updated)
  }

  const handleCancelChat = async (): Promise<void> => {
    const reqId = activeRequestIdRef.current
    if (!reqId) return
    await window.ck3Api.cancelChatMessage(reqId)
  }

  const handleStartNewChat = (nextMode?: ChatMode): void => {
    if (isSending) return
    stopTtsPlayback()
    setActiveSessionId(null)
    setMessages([])
    if (nextMode) {
      setChatMode(nextMode)
    }
  }

  const handleSelectSession = (sessionId: string): void => {
    if (isSending) return
    const target = sessions.find((s) => s.id === sessionId)
    if (!target) return
    stopTtsPlayback()
    setActiveSessionId(target.id)
    setMessages(target.messages)
    setChatMode(target.mode)
  }

  const handleChangeMode = async (nextMode: ChatMode): Promise<void> => {
    setChatMode(nextMode)
    if (activeSessionId) {
      const target = sessions.find((s) => s.id === activeSessionId)
      if (target && target.mode !== nextMode) {
        const updatedSession: ChatSession = {
          ...target,
          mode: nextMode,
          updatedAt: new Date().toISOString()
        }
        const nextList = await window.ck3Api.saveChatSession(updatedSession)
        setSessions(nextList)
      }
    }
  }

  const handleRenameSession = async (sessionId: string, nextTitle: string): Promise<void> => {
    const target = sessions.find((s) => s.id === sessionId)
    if (!target) return
    const updatedSession: ChatSession = {
      ...target,
      title: nextTitle,
      updatedAt: new Date().toISOString()
    }
    const nextList = await window.ck3Api.saveChatSession(updatedSession)
    setSessions(nextList)
  }

  const handleDeleteSession = async (sessionId: string): Promise<void> => {
    const nextList = await window.ck3Api.deleteChatSession(sessionId)
    setSessions(nextList)
    if (activeSessionId === sessionId) {
      setActiveSessionId(null)
      setMessages([])
    }
  }

  const handleBranchFromMessage = async (messageId: string): Promise<void> => {
    const msgIdx = messages.findIndex((m) => m.id === messageId)
    if (msgIdx < 0) return

    const branchedMessages = messages.slice(0, msgIdx + 1)
    const nowIso = new Date().toISOString()
    const currentSession = sessions.find((s) => s.id === activeSessionId)
    const baseTitle =
      currentSession?.title ||
      deriveSessionTitle(branchedMessages[0]?.content || '새 대화')

    const branchedSession: ChatSession = {
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: baseTitle,
      mode: chatMode,
      createdAt: nowIso,
      updatedAt: nowIso,
      parentSessionId: activeSessionId ?? undefined,
      saveContextLabel:
        chatMode === 'save_analysis' && saveSummary
          ? `${saveSummary.playerName} · ${saveSummary.gameDate}년`
          : undefined,
      messages: branchedMessages
    }

    const nextList = await window.ck3Api.saveChatSession(branchedSession)
    setSessions(nextList)
    setActiveSessionId(branchedSession.id)
    setMessages(branchedMessages)
    showToast('선택한 답변 지점부터 새로운 분기 채팅이 생성되었습니다.', 'success')
  }

  const handleSendMessage = async (promptText: string): Promise<void> => {
    if (!settings?.hasApiKey) {
      setSettingsOpen(true)
      showToast('먼저 Gemini API 키를 입력해 주세요.', 'warning')
      return
    }

    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const modeForTurn: ChatMode = chatMode
    const nowIso = new Date().toISOString()
    const sessionId =
      activeSessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const existingSession = sessions.find((s) => s.id === sessionId)

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: promptText,
      createdAt: nowIso,
      modeUsed: modeForTurn
    }

    const priorHistory = R.pipe(
      messages,
      R.filter((m) => !m.isError),
      R.map((m) => ({
        role: m.role,
        content: m.content,
        toolNotes:
          m.role === 'assistant' && m.toolSteps && m.toolSteps.length > 0
            ? R.pipe(
                m.toolSteps,
                R.filter((s) => Boolean(s.resultSummary)),
                R.map((s) => `${s.displayTitle}: ${s.resultSummary}`),
                R.take(5)
              ).join(' | ')
            : undefined
      }))
    )

    const updatedMessagesWithUser = [...messages, userMsg]
    setActiveSessionId(sessionId)
    setMessages(updatedMessagesWithUser)
    setLiveToolSteps([])
    setStreamingReplyText('')
    activeRequestIdRef.current = reqId
    setIsSending(true)

    const baseSessionMeta: ChatSession = {
      id: sessionId,
      title: existingSession?.title || deriveSessionTitle(promptText),
      mode: modeForTurn,
      createdAt: existingSession?.createdAt || nowIso,
      updatedAt: nowIso,
      parentSessionId: existingSession?.parentSessionId,
      saveContextLabel:
        modeForTurn === 'save_analysis' && saveSummary
          ? `${saveSummary.playerName} · ${saveSummary.gameDate}년`
          : existingSession?.saveContextLabel,
      messages: updatedMessagesWithUser
    }

    try {
      const response = await window.ck3Api.sendChatMessage({
        message: promptText,
        history: priorHistory,
        requestId: reqId,
        mode: modeForTurn,
        sessionId
      })

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.reply,
        createdAt: new Date().toISOString(),
        modeUsed: modeForTurn,
        modelUsed: response.modelUsed,
        toolSteps: response.toolSteps
      }

      const finalMessages = [...updatedMessagesWithUser, assistantMsg]
      setMessages(finalMessages)

      if (settings.config.autoPlayTts && !response.aborted && response.reply) {
        void playTtsForText({
          id: assistantMsg.id,
          markdownText: response.reply,
          onFallbackNotice: (reason) => showToast(reason, 'info'),
          onError: (errMsg) => showToast(errMsg, 'warning')
        })
      }

      const persisted = await window.ck3Api.saveChatSession({
        ...baseSessionMeta,
        updatedAt: new Date().toISOString(),
        messages: finalMessages
      })
      setSessions(persisted)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errorAssistantMsg: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `### 요청 처리 중 오류가 발생했습니다\n\n${errMsg}`,
        createdAt: new Date().toISOString(),
        modeUsed: modeForTurn,
        isError: true
      }
      const finalMessages = [...updatedMessagesWithUser, errorAssistantMsg]
      setMessages(finalMessages)
      const persisted = await window.ck3Api.saveChatSession({
        ...baseSessionMeta,
        updatedAt: new Date().toISOString(),
        messages: finalMessages
      })
      setSessions(persisted)
      showToast(errMsg, 'error')
    } finally {
      setIsSending(false)
      activeRequestIdRef.current = ''
      setLiveToolSteps([])
      setStreamingReplyText('')
    }
  }

  return (
    <Box
      sx={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        backgroundColor: ROYAL_COLORS.BG_DEEP
      }}
    >
      <TopStatusBar
        sidebarOpen={sidebarOpen}
        saveSummary={saveSummary}
        saveProgress={saveProgress}
        isSaveLoading={isSaveLoading}
        versionCheck={versionCheck}
        hasMessages={messages.length > 0}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        onNewChat={() => handleStartNewChat()}
        onLoadLatestSave={() => void handleLoadLatestSave()}
        onSelectSaveFile={() => void handleSelectSaveFile()}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <ChatSidebar
          open={sidebarOpen}
          sessions={sessions}
          activeSessionId={activeSessionId}
          currentMode={chatMode}
          isSending={isSending}
          onSelectSession={handleSelectSession}
          onStartNewChat={handleStartNewChat}
          onRenameSession={(id, title) => void handleRenameSession(id, title)}
          onDeleteSession={(id) => void handleDeleteSession(id)}
        />

        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0,
            position: 'relative',
            backgroundImage:
              messages.length === 0
                ? chatMode === 'general_advisor'
                  ? 'radial-gradient(ellipse 62% 52% at 50% 45%, rgba(200, 184, 152, 0.13) 0%, rgba(104, 82, 52, 0.08) 44%, rgba(16, 17, 20, 0) 75%)'
                  : 'radial-gradient(ellipse 62% 52% at 50% 45%, rgba(212, 175, 90, 0.14) 0%, rgba(124, 72, 34, 0.09) 44%, rgba(16, 17, 20, 0) 75%)'
                : 'radial-gradient(ellipse 74% 32% at 50% 0%, rgba(212, 175, 90, 0.09) 0%, rgba(108, 68, 34, 0.05) 45%, rgba(16, 17, 20, 0) 72%)'
          }}
        >
          <AutoIndexBanner
            versionCheck={versionCheck}
            indexProgress={indexProgress}
            isIndexing={isIndexing}
            dismissed={bannerDismissed}
            onStartIndexing={() => void handleStartIndexing(false)}
            onCancelIndexing={() => void handleCancelIndexing()}
            onDismiss={() => setBannerDismissed(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          <ChatArea
            messages={messages}
            liveToolSteps={liveToolSteps}
            streamingReplyText={streamingReplyText}
            isSending={isSending}
            hasApiKey={Boolean(settings?.hasApiKey)}
            chatMode={chatMode}
            selectedModel={settings?.config.selectedModel || DEFAULT_GEMINI_MODEL}
            availableModels={availableModels}
            saveSummary={saveSummary}
            sessionSaveContextLabel={
              sessions.find((s) => s.id === activeSessionId)?.saveContextLabel
            }
            onChangeMode={(nextMode) => void handleChangeMode(nextMode)}
            onSendMessage={(text) => void handleSendMessage(text)}
            onCancelMessage={() => void handleCancelChat()}
            onBranchFromMessage={(msgId) => void handleBranchFromMessage(msgId)}
            onSelectModel={(modelId) => void handleQuickSelectModel(modelId)}
            onLoadLatestSave={() => void handleLoadLatestSave()}
            onSelectSaveFile={() => void handleSelectSaveFile()}
            onOpenSettings={() => setSettingsOpen(true)}
            onNotify={showToast}
          />
        </Box>
      </Box>

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        versionCheck={versionCheck}
        isIndexing={isIndexing}
        onClose={() => setSettingsOpen(false)}
        onSaveSettings={handleSaveSettings}
        onForceReindex={() => handleStartIndexing(true)}
        onNotify={showToast}
      />

      <Snackbar
        open={toast.open}
        autoHideDuration={4000}
        onClose={() => setToast((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity={toast.severity}
          variant="filled"
          onClose={() => setToast((prev) => ({ ...prev, open: false }))}
          sx={{ borderRadius: '8px' }}
        >
          {toast.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}
