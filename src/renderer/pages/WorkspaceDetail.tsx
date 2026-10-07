import React, { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import type { Pipeline, Feature } from '@main/types/workspace'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useChannelsStore } from '../stores/channels-store'
import { useSettingsStore } from '../stores/settings-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useSandboxStore } from '../stores/sandbox-store'
import { useSandboxStatusPolling } from '../hooks/useSandboxStatusPolling'
import { DisabledReason } from '../components/shared/DisabledReason'
import { StartSessionChooser } from '../components/sandbox/StartSessionChooser'
import { SandboxBadge } from '../components/sandbox/SandboxBadge'
import { SandboxActions } from '../components/sandbox/SandboxActions'
import { TeamLevelBadge } from '../components/gamification/TeamLevelBadge'
import { PipelineTrack } from '../components/workspace/PipelineTrack'
import { ParkedPipelines } from '../components/workspace/ParkedPipelines'
import { FeatureBoard } from '../components/workspace/FeatureBoard'
import { WorkspaceTabs } from '../components/workspace/WorkspaceTabs'
import { DocViewerOverlay } from '../components/docviewer'
import { HistoryTimeline } from '../components/workspace/HistoryTimeline'
import { ChatPanel } from '../components/channels/ChatPanel'
import { PermissionButton } from '../components/channels/PermissionButton'
import { TerminalOverlay } from '../components/terminal/TerminalOverlay'
import { useDocViewerStore } from '../stores/docviewer-store'
import { useOpenCodeExplorer, browseCodeTooltip } from '../utils/code-explorer-nav'
import { consumeReturnFocus } from '../utils/code-explorer-return-focus'
import { STILL_STOPPING, isSessionStopping } from '../utils/sandbox-copy'

const STATUS_COLORS: Record<string, string> = {
  active:    'bg-co-status-active',
  waiting:   'bg-co-status-waiting',
  parked:    'bg-co-status-parked',
  idle:      'bg-co-text-muted',
  attention: 'bg-co-status-attention',
}

export default function WorkspaceDetail(): React.ReactElement {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
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

  // Focus return from the code explorer (TRD §3.8.1, step 2.21): once this
  // page's own DOM — including the `browse-code` trigger button below — has
  // (re)rendered, restore focus to whatever last opened the explorer.
  // consumeReturnFocus() is a no-op when nothing is pending (e.g. a normal
  // navigation here, not a "Back" from the explorer).
  useEffect(() => {
    if (workspace) consumeReturnFocus()
  }, [workspace])

  const openCodeExplorer = useOpenCodeExplorer()

  // Review entry points (TRD §3.8.3 FR-3, §4.2, step 2.22): changed-only,
  // baseline branch, entry 'review'. expectedBranch feeds the persistent
  // branch-mismatch banner already built in CodeExplorer.tsx (2.13/U-M2) —
  // this page only needs to supply it, never render the banner itself.
  function handlePipelineReview(pipeline: Pipeline): void {
    if (!workspace) return
    openCodeExplorer(workspace.slug, {
      changedOnly: true,
      baseline: 'branch',
      entry: 'review',
      expectedBranch: pipeline.branch,
    })
  }

  // A Feature (from docs-parser's TODO/IN_PROGRESS scan) carries no branch
  // of its own — only its matching Pipeline card does, when one is actively
  // tracking it (same slug convention, §4.2 sequence diagram: "expectedBranch:
  // pipeline?.branch"). Falls back to no expected branch (fs-diff still
  // works via 'head'; no mismatch banner) when no active pipeline matches.
  function handleFeatureReview(feature: Feature): void {
    if (!workspace) return
    const pipeline = workspace.activePipelines.find((p) => p.slug === feature.slug)
    openCodeExplorer(workspace.slug, {
      changedOnly: true,
      baseline: 'branch',
      entry: 'review',
      expectedBranch: pipeline?.branch ?? null,
    })
  }

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

  // Sandbox sessions (#0029, §3.15.4). The status is fetched on mount (polling only starts once it exists) and polled while a sandbox session runs.
  const fetchSandboxStatus = useSandboxStore((s) => s.fetchStatus)
  const sandboxEnding = useSandboxStore((s) => isSessionStopping(s.status[terminalSlug]?.session.state))
  const chooserRequested = useSandboxStore((s) => s.chooserRequest === terminalSlug && terminalSlug !== '')
  const clearChooserRequest = useSandboxStore((s) => s.clearChooserRequest)
  const [chooserOpen, setChooserOpen] = useState(false)
  const startButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (terminalSlug) void fetchSandboxStatus(terminalSlug)
  }, [terminalSlug, fetchSandboxStatus])
  useSandboxStatusPolling(terminalSlug)

  // A notification click ("Sandbox image is ready") can ask for the chooser: it is open while either the user or the request wants it, and closing clears both.
  // A request the chooser cannot honour (a session already exists) is dropped now, not left to pop open later.
  const chooserBlocked = sessionState !== 'none'
  useEffect(() => {
    if (chooserRequested && chooserBlocked) clearChooserRequest()
  }, [chooserRequested, chooserBlocked, clearChooserRequest])
  const chooserVisible = chooserOpen || chooserRequested
  function closeChooser(): void {
    setChooserOpen(false)
    clearChooserRequest()
  }

  // Two-tap End Session confirmation (amendment A6, P15)
  const [isConfirming, setIsConfirming] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  // Start Session opens the chooser (Host or Sandbox); Host runs the unchanged host spawn.
  function handleStartSession(): void {
    setChooserOpen(true)
  }

  function handleStartHost(): void {
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
      {/* relative z-30: co-animate-in leaves a transform (a stacking context), so without a z-index the body below paints over the Start Session chooser. */}
      <header className="relative z-30 px-6 py-5 border-b border-white/[0.04] flex items-center gap-4 co-animate-in shrink-0">
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

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => openFolder(workspace.docsRoot, workspace.slug)}
            disabled={!workspace.docsRootExists}
            title={workspace.docsRootExists ? undefined : 'Docs directory not found — try refreshing'}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors ${!workspace.docsRootExists ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M1 3.5C1 2.94772 1.44772 2.5 2 2.5H4.5L5.5 3.5H10C10.5523 3.5 11 3.94772 11 4.5V9C11 9.55228 10.5523 10 10 10H2C1.44772 10 1 9.55228 1 9V3.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
            </svg>
            Browse Docs
          </button>
          <button
            data-return-focus={`browse-code:${workspace.slug}`}
            onClick={() => openCodeExplorer(workspace.slug, { entry: 'browse' })}
            disabled={workspace.repoRootStatus !== 'ok'}
            title={browseCodeTooltip(workspace.repoRootStatus)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors ${workspace.repoRootStatus !== 'ok' ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M4 3L1.5 6L4 9M8 3L10.5 6L8 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Browse Code
          </button>
        </div>

        {/* Session controls (A15, A6, A9) */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <PermissionButton workspaceSlug={workspace.slug} />
          {/* Renders only for a workspace that has a sandbox; both hide themselves otherwise. */}
          <SandboxBadge slug={workspace.slug} skin="office" />
          <SandboxActions slug={workspace.slug} skin="office" />
          {/* Start / End Session */}
          {sessionState === 'none' && (
            <div className="relative">
              <DisabledReason reason={sandboxEnding ? STILL_STOPPING : null} skin="office">
                {(props) => (
                  <button
                    ref={startButtonRef}
                    onClick={handleStartSession}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                    {...props}
                  >
                    Start Session
                  </button>
                )}
              </DisabledReason>
              {chooserVisible && (
                <div className="absolute right-0 top-full z-40 mt-2">
                  <StartSessionChooser
                    slug={terminalSlug}
                    skin="office"
                    onStartHost={handleStartHost}
                    onClose={closeChooser}
                    onShowLog={() => {
                      // The build log lives in Sandbox settings: land on that tab, not the default one.
                      useSandboxStore.getState().requestSettings(terminalSlug)
                      navigate('/settings')
                    }}
                    returnFocusRef={startButtonRef}
                  />
                </div>
              )}
            </div>
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
            <PipelineTrack
              key={pipeline.slug}
              pipeline={pipeline}
              onReview={handlePipelineReview}
              workspaceSlug={workspace.slug}
            />
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

          {/* Board | Memory | README. Keyed by slug so the tab and expanded columns reset per workspace. */}
          <WorkspaceTabs
            key={workspace.slug}
            board={
              <FeatureBoard
                features={workspace.features}
                ideationItems={workspace.ideationItems}
                workspaceSlug={workspace.slug}
                onReview={handleFeatureReview}
              />
            }
            memory={workspace.projectContext || null}
            readme={workspace.readmeContent}
          />

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

      {/* Single doc viewer mount: serves the header Browse Docs button and feature card clicks on any tab. */}
      <DocViewerOverlay />
    </div>
  )
}
