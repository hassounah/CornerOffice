import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelSession, ConnectionState } from '@main/types/channels'
import { useChannelsStore } from '../../stores/channels-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { PulseDot } from '../shared/PulseDot'
import { SessionSelector } from './SessionSelector'
import { ChatMessage } from './ChatMessage'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Distance from bottom (px) within which we consider the user to be "at bottom". */
const SCROLL_BOTTOM_THRESHOLD = 50

/** Must match ChannelSendMessageSchema max in schemas.ts */
const MAX_MESSAGE_LENGTH = 10_000

/** Show warning color when within this many chars of the limit. */
const WARN_THRESHOLD = 500

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a path: strip trailing slashes. No Node `path` needed — just string ops. */
function normalizePath(p: string): string {
  return p.replace(/\/+$/, '')
}

/** Map connection state to a human-readable label. */
function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting…'
    case 'reconnecting': return 'Reconnecting…'
    case 'disconnected': return 'Disconnected'
  }
}

/** Indicator dot for each connection state, matching the PulseDot visual pattern. */
function ConnectionDot({ state }: { state: ConnectionState }): React.ReactElement {
  if (state === 'connected') return <PulseDot />
  if (state === 'connecting' || state === 'reconnecting') {
    return (
      <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
        <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-40" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]" />
      </span>
    )
  }
  return <span className="relative inline-flex h-2 w-2 shrink-0 rounded-full bg-stone-600" aria-hidden="true" />
}

/** Count down seconds until reconnectAt timestamp. Returns null when not applicable.
 * State is updated inside the interval callback (not the effect body) to satisfy react-hooks/purity
 * and react-hooks/set-state-in-effect. Clears in effect cleanup when reconnectAt is removed.
 */
function useReconnectCountdown(reconnectAt: number | undefined): number | null {
  const [secsLeft, setSecsLeft] = useState<number | null>(null)

  useEffect(() => {
    if (reconnectAt == null) return
    const id = setInterval(() => {
      setSecsLeft(Math.max(0, Math.ceil((reconnectAt - Date.now()) / 1000)))
    }, 500)
    return () => {
      clearInterval(id)
      setSecsLeft(null)
    }
  }, [reconnectAt])

  return secsLeft
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  workspaceSlug: string
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatPanel({ workspaceSlug, className = '' }: ChatPanelProps): React.ReactElement {
  const sessions = useChannelsStore((s) => s.sessions)
  const messages = useChannelsStore((s) => s.messages)
  const activeSessionId = useChannelsStore((s) => s.activeSessionId)
  const setActiveSession = useChannelsStore((s) => s.setActiveSession)
  const sendMessage = useChannelsStore((s) => s.sendMessage)

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const workspace = workspaces.find((w) => w.slug === workspaceSlug)

  // Filter sessions whose workspaceDir matches this workspace's path
  const filteredSessions: ChannelSession[] = useMemo(
    () =>
      workspace
        ? sessions.filter(
            (s) => normalizePath(s.workspaceDir) === normalizePath(workspace.path),
          )
        : [],
    [sessions, workspace],
  )

  // Active session — auto-select first if none chosen
  const activeSession =
    filteredSessions.find((s) => s.shortId === activeSessionId) ??
    filteredSessions[0] ??
    null

  // Sync auto-selected session into store
  useEffect(() => {
    if (filteredSessions.length > 0 && activeSessionId == null) {
      setActiveSession(filteredSessions[0].shortId)
    }
  }, [filteredSessions, activeSessionId, setActiveSession])

  const currentMessages = activeSession ? (messages[activeSession.shortId] ?? []) : []

  // ─── Auto-scroll state ───────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const prevMessageCount = useRef(currentMessages.length)

  /** Check if scroll is near the bottom. */
  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Scroll to bottom on initial mount when messages already exist
  const initialScrollDone = useRef(false)
  useEffect(() => {
    if (!initialScrollDone.current && currentMessages.length > 0) {
      initialScrollDone.current = true
      scrollToBottom()
    }
  }, [currentMessages.length, scrollToBottom])

  // Scroll to bottom on new messages when already at bottom
  useEffect(() => {
    const newCount = currentMessages.length
    if (newCount > prevMessageCount.current) {
      if (atBottom) {
        scrollToBottom()
        setHasNewMessages(false)
      } else {
        setHasNewMessages(true)
      }
    }
    prevMessageCount.current = newCount
  }, [currentMessages.length, atBottom, scrollToBottom])

  const handleScroll = useCallback(() => {
    const isAtBottom = checkAtBottom()
    setAtBottom(isAtBottom)
    if (isAtBottom) setHasNewMessages(false)
  }, [checkAtBottom])

  // ─── Input state ─────────────────────────────────────────────────────────
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(async () => {
    if (!activeSession || !inputText.trim() || sending || inputText.length > MAX_MESSAGE_LENGTH) return
    const text = inputText.trim()
    setInputText('')
    setSending(true)
    try {
      await sendMessage(activeSession.shortId, text)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [activeSession, inputText, sending, sendMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSend()
      }
    },
    [handleSend],
  )

  // ─── Derived state ───────────────────────────────────────────────────────
  const isReconnecting = activeSession?.connectionState === 'reconnecting'
  const isConnected = activeSession?.connectionState === 'connected'
  const isDisconnected = activeSession?.connectionState === 'disconnected'
  const isOverLimit = inputText.length > MAX_MESSAGE_LENGTH
  const isNearLimit = inputText.length > MAX_MESSAGE_LENGTH - WARN_THRESHOLD
  const canSend = !!activeSession && isConnected && !sending && !isOverLimit

  // ─── Reconnect countdown ─────────────────────────────────────────────────
  const reconnectSecsLeft = useReconnectCountdown(activeSession?.reconnectAt)

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={`flex flex-col h-full ${className}`}>

      {/* ── Header ── */}
      {filteredSessions.length > 0 && (
        <div className="shrink-0 px-3 py-2 border-b border-stone-800 space-y-1.5">
          {/* Session selector — only shown when multiple sessions */}
          {filteredSessions.length > 1 && (
            <SessionSelector
              sessions={filteredSessions}
              activeSessionId={activeSession?.shortId ?? null}
              onSelect={setActiveSession}
            />
          )}

          {/* Connection status + pipeline stage badge */}
          {activeSession && (
            <div className="flex items-center gap-2 min-h-[1.25rem]">
              <ConnectionDot state={activeSession.connectionState} />
              <span className={`text-xs font-medium ${
                isConnected ? 'text-emerald-400' :
                isReconnecting ? 'text-amber-400' :
                activeSession.connectionState === 'connecting' ? 'text-amber-400' :
                'text-stone-500'
              }`}>
                {connectionLabel(activeSession.connectionState)}
                {isReconnecting && reconnectSecsLeft != null && reconnectSecsLeft > 0 && (
                  <span className="ml-1 text-stone-500"> in {reconnectSecsLeft}s</span>
                )}
              </span>
              {activeSession.pipelineStage && (
                <span className="rounded bg-stone-700/70 px-1.5 py-0.5 text-[10px] font-mono text-stone-300 uppercase tracking-wide">
                  {activeSession.pipelineStage}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Message area ── */}
      <div className="relative flex-1 min-h-0">
        {filteredSessions.length === 0 ? (
          /* Empty state */
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-stone-500">No active sessions</p>
          </div>
        ) : (
          <>
            {/* Reconnect banner */}
            {isReconnecting && (
              <div className="absolute top-0 inset-x-0 z-10 bg-amber-900/30 border-b border-amber-700/40 px-3 py-1.5 text-center">
                <span className="text-xs text-amber-300">
                  Chat history cleared — messages appear in real time
                </span>
              </div>
            )}

            {/* Session ended banner */}
            {isDisconnected && (
              <div className="absolute top-0 inset-x-0 z-10 bg-stone-900/80 border-b border-stone-700/60 px-3 py-1.5 text-center">
                <span className="text-xs text-stone-400">
                  Session ended — history preserved
                </span>
              </div>
            )}

            {/* Scrollable message list */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              role="log"
              aria-live="polite"
              aria-label="Chat messages"
              className="h-full overflow-y-auto px-3 py-3 flex flex-col gap-2"
            >
              {currentMessages.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-xs text-stone-600">No messages yet</p>
                </div>
              ) : (
                currentMessages.map((msg) => (
                  <ChatMessage key={msg.id} message={msg} />
                ))
              )}
            </div>

            {/* New-message chip */}
            {hasNewMessages && (
              <button
                type="button"
                onClick={() => {
                  scrollToBottom()
                  setHasNewMessages(false)
                }}
                className="
                  absolute bottom-3 left-1/2 -translate-x-1/2
                  rounded-full bg-amber-700/90 px-3 py-1 text-xs text-amber-100
                  shadow-md hover:bg-amber-600/90 transition-colors
                "
              >
                New messages ↓
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Input ── */}
      {filteredSessions.length > 0 && (
        <div className="shrink-0 border-t border-stone-800 px-3 py-2 space-y-1">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canSend && !isOverLimit}
            placeholder={
              !activeSession
                ? 'No session selected'
                : isDisconnected
                  ? 'Session ended'
                  : !isConnected
                    ? 'Waiting for connection…'
                    : 'Message Claude… (Enter to send, Shift+Enter for newline)'
            }
            rows={2}
            className={`
              w-full resize-none rounded-md
              bg-stone-900/80 border
              px-3 py-2 text-sm text-stone-200 placeholder:text-stone-600
              focus:outline-none focus:ring-1
              disabled:opacity-40 disabled:cursor-not-allowed
              ${isOverLimit
                ? 'border-red-500/80 focus:ring-red-500/60'
                : isNearLimit
                  ? 'border-amber-500/60 focus:ring-amber-500/60'
                  : 'border-stone-700/60 focus:ring-amber-500/60'}
            `}
          />
          <div className="flex items-center justify-between px-0.5">
            {isOverLimit ? (
              <span className="text-[11px] text-red-400">
                Message exceeds {MAX_MESSAGE_LENGTH.toLocaleString()} character limit
              </span>
            ) : (
              <span />
            )}
            {inputText.length > 0 && (
              <span className={`text-[11px] tabular-nums ${
                isOverLimit ? 'text-red-400' :
                isNearLimit ? 'text-amber-400' :
                'text-stone-600'
              }`}>
                {inputText.length.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
