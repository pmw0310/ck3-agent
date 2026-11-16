import React, { useState } from 'react'
import {
  Box,
  Button,
  Divider,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined'
import AutoStoriesOutlinedIcon from '@mui/icons-material/AutoStoriesOutlined'
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded'
import CastleOutlinedIcon from '@mui/icons-material/CastleOutlined'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import * as R from 'remeda'
import type { ChatMode, ChatSession } from '@shared/types'
import { FONT_FAMILIES, ROYAL_COLORS } from '@renderer/theme'

export interface ChatSidebarProps {
  open: boolean
  sessions: ChatSession[]
  activeSessionId: string | null
  currentMode: ChatMode
  isSending: boolean
  onSelectSession: (sessionId: string) => void
  onStartNewChat: (mode?: ChatMode) => void
  onRenameSession: (sessionId: string, nextTitle: string) => void
  onDeleteSession: (sessionId: string) => void
}

type SessionFilter = 'all' | ChatMode

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  open,
  sessions,
  activeSessionId,
  currentMode,
  isSending,
  onSelectSession,
  onStartNewChat,
  onRenameSession,
  onDeleteSession
}) => {
  const [filterMode, setFilterMode] = useState<SessionFilter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const visibleSessions = R.pipe(
    sessions,
    R.filter((s) => (filterMode === 'all' ? true : s.mode === filterMode))
  )

  const handleBeginEdit = (session: ChatSession, event: React.MouseEvent): void => {
    event.stopPropagation()
    setEditingId(session.id)
    setEditDraft(session.title)
  }

  const handleCommitEdit = (sessionId: string, event?: React.SyntheticEvent): void => {
    event?.stopPropagation()
    const trimmed = editDraft.trim()
    if (trimmed) {
      onRenameSession(sessionId, trimmed)
    }
    setEditingId(null)
  }

  return (
    <Box
      component="aside"
      aria-hidden={!open}
      sx={{
        width: open ? 276 : 0,
        minWidth: open ? 276 : 0,
        height: '100%',
        overflow: 'hidden',
        visibility: open ? 'visible' : 'hidden',
        pointerEvents: open ? 'auto' : 'none',
        transition: 'width 0.2s ease, min-width 0.2s ease, visibility 0.2s ease',
        backgroundColor: '#141519',
        borderRight: open ? `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}` : 'none',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 12
      }}
    >
      <Box
        sx={{
          width: 276,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          p: 1.5,
          gap: 1.25
        }}
      >
        {/* New Chat Action Buttons */}
        <Button
          fullWidth
          disabled={isSending}
          startIcon={<AddCommentOutlinedIcon sx={{ fontSize: 17 }} />}
          onClick={() => onStartNewChat(currentMode)}
          sx={{
            justifyContent: 'flex-start',
            py: 0.9,
            px: 1.5,
            borderRadius: '8px',
            backgroundColor: ROYAL_COLORS.BG_PILL,
            color: ROYAL_COLORS.TEXT_PRIMARY,
            border: `1px solid ${ROYAL_COLORS.GOLD_DIM}`,
            fontWeight: 500,
            fontSize: '0.84rem',
            '&:hover': {
              backgroundColor: ROYAL_COLORS.BG_PILL_HOVER,
              borderColor: ROYAL_COLORS.GOLD_MAIN
            }
          }}
        >
          새 채팅 시작
        </Button>

        {/* Filter Segment Tabs (전체 / 판세 분석 / 일반 현인) */}
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            p: 0.4,
            borderRadius: '8px',
            backgroundColor: '#1A1B20',
            border: `1px solid ${ROYAL_COLORS.BORDER_SUBTLE}`
          }}
        >
          {(
            [
              { key: 'all', label: '전체' },
              { key: 'save_analysis', label: '판세 분석' },
              { key: 'general_advisor', label: '일반 현인' }
            ] as const
          ).map((tab) => {
            const active = filterMode === tab.key
            return (
              <Box
                key={tab.key}
                onClick={() => setFilterMode(tab.key)}
                sx={{
                  flex: 1,
                  py: 0.45,
                  textAlign: 'center',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.74rem',
                  fontWeight: active ? 700 : 400,
                  color: active ? '#FFFFFF' : ROYAL_COLORS.TEXT_SECONDARY,
                  backgroundColor: active ? '#282A33' : 'transparent',
                  transition: 'all 0.15s ease',
                  '&:hover': {
                    color: '#FFFFFF'
                  }
                }}
              >
                {tab.label}
              </Box>
            )
          })}
        </Stack>

        <Divider sx={{ opacity: 0.6 }} />

        <Typography
          variant="caption"
          sx={{
            px: 0.75,
            color: ROYAL_COLORS.TEXT_SECONDARY,
            fontWeight: 700,
            letterSpacing: '0.02em'
          }}
        >
          최근 채팅
        </Typography>

        {/* Scrollable Chat Session List */}
        <Box sx={{ flex: 1, overflowY: 'auto', pr: 0.25 }}>
          {visibleSessions.length === 0 ? (
            <Box sx={{ px: 1, py: 4, textAlign: 'center' }}>
              <Typography variant="caption" sx={{ color: ROYAL_COLORS.TEXT_SECONDARY }}>
                저장된 대화가 없습니다.
                <br />
                판세 분석이나 일반 질문으로 새 대화를 시작해 보세요.
              </Typography>
            </Box>
          ) : (
            <Stack spacing={0.5}>
              {visibleSessions.map((session) => {
                const isSelected = session.id === activeSessionId
                const isGeneral = session.mode === 'general_advisor'
                const isEditing = editingId === session.id

                return (
                  <Box
                    key={session.id}
                    onClick={() => {
                      if (!isSending && !isEditing) {
                        onSelectSession(session.id)
                      }
                    }}
                    sx={{
                      px: 1.15,
                      py: 0.85,
                      borderRadius: '8px',
                      cursor: isSending ? 'default' : 'pointer',
                      backgroundColor: isSelected ? '#23252E' : 'transparent',
                      border: isSelected
                        ? `1px solid ${isGeneral ? ROYAL_COLORS.SAGE_DIM : ROYAL_COLORS.GOLD_DIM}`
                        : '1px solid transparent',
                      transition: 'background-color 0.14s ease',
                      '&:hover': {
                        backgroundColor: isSelected ? '#262933' : 'rgba(255, 255, 255, 0.04)'
                      },
                      '&:hover .session-actions, &:focus-within .session-actions': {
                        opacity: 1
                      }
                    }}
                  >
                    {isEditing ? (
                      <Stack
                        direction="row"
                        spacing={0.5}
                        alignItems="center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <TextField
                          size="small"
                          variant="standard"
                          fullWidth
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return
                            if (e.key === 'Enter') handleCommitEdit(session.id, e)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          slotProps={{
                            input: {
                              sx: { fontSize: '0.82rem', color: '#FFF' }
                            }
                          }}
                        />
                        <IconButton size="small" onClick={(e) => handleCommitEdit(session.id, e)}>
                          <CheckRoundedIcon sx={{ fontSize: 15, color: '#5BB98B' }} />
                        </IconButton>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(null)
                          }}
                        >
                          <CloseRoundedIcon sx={{ fontSize: 15, color: ROYAL_COLORS.TEXT_SECONDARY }} />
                        </IconButton>
                      </Stack>
                    ) : (
                      <Stack direction="row" spacing={1} alignItems="flex-start">
                        <Tooltip
                          title={isGeneral ? '일반 질문 · 현인 모드' : '세이브 판세 분석 모드'}
                          arrow
                        >
                          <Box sx={{ pt: 0.25 }}>
                            {isGeneral ? (
                              <AutoStoriesOutlinedIcon
                                sx={{ fontSize: 16, color: ROYAL_COLORS.SAGE_LIGHT }}
                              />
                            ) : (
                              <CastleOutlinedIcon
                                sx={{ fontSize: 16, color: ROYAL_COLORS.GOLD_LIGHT }}
                              />
                            )}
                          </Box>
                        </Tooltip>

                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography
                            sx={{
                              fontSize: '0.83rem',
                              fontWeight: isSelected ? 700 : 500,
                              color: isSelected ? '#FFFFFF' : ROYAL_COLORS.TEXT_PRIMARY,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontFamily: FONT_FAMILIES.GOTHIC
                            }}
                          >
                            {session.title}
                          </Typography>

                          <Stack direction="row" spacing={0.5} alignItems="center">
                            {session.parentSessionId && (
                              <CallSplitRoundedIcon
                                sx={{ fontSize: 11, color: ROYAL_COLORS.GOLD_LIGHT }}
                              />
                            )}
                            <Typography
                              variant="caption"
                              sx={{
                                fontSize: '0.7rem',
                                color: ROYAL_COLORS.TEXT_SECONDARY,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              {isGeneral
                                ? '일반 현인'
                                : session.saveContextLabel || '세이브 판세 분석'}
                            </Typography>
                          </Stack>
                        </Box>

                        <Stack
                          direction="row"
                          spacing={0.15}
                          className="session-actions"
                          sx={{
                            opacity: isSelected ? 0.85 : 0,
                            transition: 'opacity 0.15s ease',
                            flexShrink: 0
                          }}
                        >
                          <Tooltip title="대화 제목 변경" arrow>
                            <IconButton
                              size="small"
                              sx={{ p: 0.3, color: ROYAL_COLORS.TEXT_SECONDARY }}
                              onClick={(e) => handleBeginEdit(session, e)}
                            >
                              <EditOutlinedIcon sx={{ fontSize: 14 }} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="대화 삭제" arrow>
                            <IconButton
                              size="small"
                              sx={{
                                p: 0.3,
                                color: ROYAL_COLORS.TEXT_SECONDARY,
                                '&:hover': { color: '#E06666' }
                              }}
                              onClick={(e) => {
                                e.stopPropagation()
                                onDeleteSession(session.id)
                              }}
                            >
                              <DeleteOutlineRoundedIcon sx={{ fontSize: 15 }} />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </Stack>
                    )}
                  </Box>
                )
              })}
            </Stack>
          )}
        </Box>
      </Box>
    </Box>
  )
}
