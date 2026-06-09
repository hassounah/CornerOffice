import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChannelsStore } from '../stores/channels-store'
import { useSettingsStore } from '../stores/settings-store'
import { useTerminalStore } from '../stores/terminal-store'
import { TeamLevelBadge } from '../components/gamification/TeamLevelBadge'
import { PipelineTrack } from '../components/workspace/PipelineTrack'
import { ParkedPipelines } from '../components/workspace/ParkedPipelines'
import { FeatureBoard } from '../components/workspace/FeatureBoard'
import { MemoryPanel } from '../components/workspace/MemoryPanel'
import { ReadmePanel } from '../components/workspace/ReadmePanel'
import { HistoryTimeline } from '../components/workspace/HistoryTimeline'
import { ChatPanel } from '../components/channels/ChatPanel'
import { PermissionButton } from '../components/channels/PermissionButton'
import { TerminalOverlay } from '../components/terminal/TerminalOverlay'
import { useDocViewerStore } from '../stores/docviewer-store'

const STATUS_COLORS: Record<string, string> = {
  active:    'bg-co-status-active',
  waiting:   'bg-co-status-waiting',
  parked:    'bg-co-status-parked',
  idle:      'bg-co-text-muted',
  attention: 'bg-co-status-attention',
}

export default function WorkspaceDetail(): React.ReactElement {
  const { slug } = useParams<{ slug: string }>()
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.slug === slug) ?? null)
  const fetchOne = useWorkspaceStore((s) => s.fetchOne)
  const storeLoading = useWorkspaceStore((s) => s.loading)
  const [error, setError] = useState<string | null>(null)

  // Check if any channel sessions are active for this workspace
  const allSessions = useChannelsStore((s) => s.sessions)
  const hasSessions = workspace
    ? allSessions.some(
        (s) => s.workspaceDir.replace(/\/+$/, '') === workspace.path.replace(/\/+$/, ''),
      )
    : false
  const timelineContainerRef = useRef<HTMLDivElement>(null)
  const [timelineHeight, setTimelineHeight] = useState(400)

  // Always fetch fresh workspace data when opened
  useEffect(() => {
    if (!slug) return
    let cancelled = false
    void fetchOne(slug)
      .then(() => { if (!cancelled) setError(null) })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [slug, fetchOne])

  const loading = storeLoading && !workspace

  const terminalFontSize = useSettingsStore((s) => s.config?.terminal?.fontSize ?? 14)
  const terminalWorkspaceBounds = useSettingsStore((s) => s.config?.terminal?.windowBounds?.workspace)
  const updateConfig = useSettingsStore((s) => s.updateConfig)

  // Terminal store (A4, A6, A9, A15)
  const terminalSlug = slug ?? ''
  const sessionState = useTerminalStore((s) => s.sessions[terminalSlug] ?? 'none')
  const overlayVisible = useTerminalStore((s) => s.overlayVisible[terminalSlug] ?? false)
  const spawnError = useTerminalStore((s) => s.spawnError[terminalSlug] ?? null)
  const { spawn, kill, showOverlay, hideOverlay, clearSpawnError } = useTerminalStore()

  const openFolder = useDocViewerStore((s) => s.openFolder)

  // Two-tap End Session confirmation (amendment A6, P15)
  const [isConfirming, setIsConfirming] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  function handleStartSession(): void {
    void spawn(terminalSlug)
  }

  function handleEndSession(): void {
    if (isConfirming) {
      if (confirmTimerRef.current !== null) {
        clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = null
      }
      setIsConfirming(false)
      void kill(terminalSlug)
    } else {
      setIsConfirming(true)
      confirmTimerRef.current = setTimeout(() => {
        confirmTimerRef.current = null
        setIsConfirming(false)
      }, 3_000)
    }
  }

  useEffect(() => {
    const el = timelineContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setTimelineHeight(Math.max(200, entry.contentRect.height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="h-5 w-5 rounded-full border-2 border-co-accent border-t-transparent animate-spin motion-reduce:animate-none" />
      </div>
    )
  }

  if (error || !workspace) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-red-400 text-sm">{error ?? 'Workspace not found.'}</p>
      </div>
    )
  }

  const hasContent = workspace.activePipelines.length > 0 || workspace.shippedFeatures.length > 0 || workspace.parkedPipelines.length > 0

  return (
    <div className="flex flex-col h-full">
      {/* Header — clean, spacious */}
      <header className="px-6 py-5 border-b border-white/[0.04] flex items-center gap-4 co-animate-in shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              aria-label={`Status: ${workspace.status}`}
              className={`h-2.5 w-2.5 rounded-full shrink-0 ${STATUS_COLORS[workspace.status] ?? 'bg-co-text-muted'}`}
            />
            <h1 className="text-lg font-semibold text-co-text-primary truncate tracking-tight">
              {workspace.displayName}
            </h1>
          </div>
          <p className="text-[11px] text-co-text-muted mt-1 font-mono truncate opacity-60">{workspace.path}</p>
        </div>

        <TeamLevelBadge level={workspace.level} />

        {/* Session controls (A15, A6, A9) */}
        <div className="flex items-center gap-2 shrink-0">
          <PermissionButton workspaceSlug={workspace.slug} />
          {/* Start / End Session */}
          {sessionState === 'none' && (
            <button
              onClick={handleStartSession}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              Start Session
            </button>
          )}
          {sessionState === 'starting' && (
            <button disabled className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-500 flex items-center gap-1.5 cursor-not-allowed">
              <span className="h-3 w-3 rounded-full border border-zinc-500 border-t-transparent animate-spin" />
              Starting...
            </button>
          )}
          {(sessionState === 'running' || sessionState === 'stopping') && (
            <button
              onClick={sessionState === 'running' ? handleEndSession : undefined}
              disabled={sessionState === 'stopping'}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sessionState === 'stopping'
                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                  : isConfirming
                    ? 'bg-amber-900/40 text-amber-400 hover:bg-amber-900/60'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              {sessionState === 'stopping' ? 'Ending...' : isConfirming ? 'Confirm End?' : 'End Session'}
            </button>
          )}

          {/* Show / Hide Session (only when a session exists) */}
          {(sessionState === 'running' || sessionState === 'starting') && (
            overlayVisible ? (
              <button
                onClick={() => hideOverlay(terminalSlug)}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Hide Session
              </button>
            ) : (
              <button
                onClick={() => showOverlay(terminalSlug)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  workspace.status === 'attention'
                    ? 'bg-amber-900/30 text-amber-400 hover:bg-amber-900/50 shadow-[0_0_8px_rgba(245,158,11,0.3)]'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                }`}
              >
                Show Session
              </button>
            )
          )}
        </div>
      </header>

      {/* Spawn error banner (amendment A4) */}
      {spawnError && (
        <div className="shrink-0 px-4 py-2 bg-red-950/60 border-b border-red-900/40 flex items-center justify-between gap-3">
          <span className="text-xs text-red-400">{spawnError}</span>
          <button
            onClick={() => clearSpawnError(terminalSlug)}
            className="text-xs text-red-500 hover:text-red-300 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Body — split when sessions active */}
      <div className="flex flex-row flex-1 min-h-0 relative">
        {/* Left: scrollable content */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5 co-stagger">
          {/* Active pipelines */}
          {workspace.activePipelines.map((pipeline) => (
            <PipelineTrack key={pipeline.slug} pipeline={pipeline} />
          ))}

          {/* Parked pipelines */}
          {workspace.parkedPipelines.length > 0 && (
            <ParkedPipelines pipelines={workspace.parkedPipelines} />
          )}

          {/* Empty state — quiet, not a billboard */}
          {!hasContent && (
            <div className="rounded-co py-10 text-center flex flex-col gap-2">
              {workspace.projectContext && (
                <p className="text-[13px] text-co-text-secondary max-w-md mx-auto leading-relaxed">
                  {workspace.projectContext}
                </p>
              )}
              <p className="text-[13px] text-co-text-muted">No features shipped yet.</p>
            </div>
          )}

          {/* Feature board */}
          <FeatureBoard features={workspace.features} ideationItems={workspace.ideationItems} workspaceSlug={workspace.slug} />

          {/* Memory panel */}
          {workspace.projectContext && (
            <MemoryPanel content={workspace.projectContext} />
          )}

          {/* README panel + Browse Docs button */}
          <div className="flex flex-row gap-3 items-start">
            <div className="flex-1">
              <ReadmePanel content={workspace.readmeContent} />
            </div>
            <button
              onClick={() => openFolder(workspace.docsRoot, workspace.slug)}
              disabled={!workspace.docsRootExists}
              title={workspace.docsRootExists ? undefined : 'Docs directory not found — try refreshing'}
              className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest rounded text-co-text-muted border border-white/[0.06] bg-transparent hover:bg-white/[0.04] transition-colors ${!workspace.docsRootExists ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M1 3.5C1 2.94772 1.44772 2.5 2 2.5H4.5L5.5 3.5H10C10.5523 3.5 11 3.94772 11 4.5V9C11 9.55228 10.5523 10 10 10H2C1.44772 10 1 9.55228 1 9V3.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
              </svg>
              Browse Docs
            </button>
          </div>

          {/* History timeline */}
          {workspace.shippedFeatures.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold text-co-text-muted uppercase tracking-widest mb-3">
                Shipped Features ({workspace.shippedFeatures.length})
              </h3>
              <div
                ref={timelineContainerRef}
                className="flex-1 co-card overflow-hidden"
                style={{ minHeight: 200, maxHeight: 480 }}
              >
                <HistoryTimeline
                  features={workspace.shippedFeatures}
                  height={timelineHeight}
                />
              </div>
            </section>
          )}
        </div>

        {/* Right: ChatPanel — only when sessions active */}
        {hasSessions && (
          <div className="w-[350px] shrink-0 border-l border-stone-800">
            <ChatPanel workspaceSlug={workspace.slug} className="h-full" />
          </div>
        )}

        {/* Terminal overlay — covers body area when session is active (A15) */}
        {overlayVisible && (sessionState === 'starting' || sessionState === 'running') && (
          <TerminalOverlay
            workspaceSlug={terminalSlug}
            workspaceName={workspace.displayName}
            fontSize={terminalFontSize}
            windowBounds={terminalWorkspaceBounds}
            onBoundsChange={(bounds) => {
              void updateConfig({ terminal: { windowBounds: { workspace: bounds } } } as Parameters<typeof updateConfig>[0])
            }}
            onHide={() => hideOverlay(terminalSlug)}
          />
        )}
      </div>
    </div>
  )
}
