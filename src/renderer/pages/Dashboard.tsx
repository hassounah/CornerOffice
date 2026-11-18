import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useWorkspaceStore } from '../stores/workspace-store'
import { useActivityStore } from '../stores/activity-store'
import { useSettingsStore } from '../stores/settings-store'
import { useSidebarStore } from '../stores/sidebar-store'
import { useTerminalStore } from '../stores/terminal-store'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'
import { isUnattributed } from '../utils/unattributed'
import { WorkspaceCard } from '../components/dashboard/WorkspaceCard'
import { ActivityFeed } from '../components/dashboard/ActivityFeed'
import { TerminalOverlay } from '../components/terminal/TerminalOverlay'
import { StoreHealthNotice } from '../components/workspaces/StoreHealthNotice'
import { EmptyWorkspacesPrompt } from '../components/workspaces/EmptyWorkspacesPrompt'
import { CreateWorkspaceDialog } from '../components/workspaces/CreateWorkspaceDialog'
import type { PluginStatus } from '@main/types'

const SHELL_SESSION_KEY = 'shell:office_shell'
const SHELL_HOUSE_ID = 'office_shell'

/** Whether any agent's event hooks are on. `null` until the first answer: no banner is flashed before it. */
async function loadEventsEnabled(): Promise<boolean | null> {
  try {
    const statuses = unwrapIpc(await window.cornerOffice.plugin.getStatus() as IpcResponse<Record<string, PluginStatus>>)
    return Object.values(statuses).some((status) => status.eventsEnabled)
  } catch {
    return null
  }
}

export default function Dashboard(): React.ReactElement {
  const navigate = useNavigate()
  const { workspaces, fetchAll } = useWorkspaceStore()
  const { items: activityItems, fetchFeed } = useActivityStore()
  const terminalFontSize = useSettingsStore((s) => s.config?.terminal?.fontSize ?? 14)
  const terminalShellBounds = useSettingsStore((s) => s.config?.terminal?.windowBounds?.shell)
  const updateConfig = useSettingsStore((s) => s.updateConfig)
  const requestShowHidden = useSidebarStore((s) => s.requestShowHidden)
  const sessionState = useTerminalStore((s) => s.sessions[SHELL_SESSION_KEY] ?? 'none')
  const overlayVisible = useTerminalStore((s) => s.overlayVisible[SHELL_SESSION_KEY] ?? false)
  const { spawnShell, showOverlay, hideOverlay } = useTerminalStore()
  const feedContainerRef = useRef<HTMLDivElement>(null)
  const [feedHeight, setFeedHeight] = React.useState(500)
  const [eventsEnabled, setEventsEnabled] = useState<boolean | null>(null)
  /** The first fetch has answered, so an empty list means an empty registry, not "not loaded yet". */
  const loaded = useWorkspaceStore((s) => s.loaded)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void fetchAll()
    void fetchFeed()
  }, [fetchAll, fetchFeed])

  useEffect(() => {
    let cancelled = false
    void loadEventsEnabled().then((enabled) => {
      if (!cancelled) setEventsEnabled(enabled)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const el = feedContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setFeedHeight(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Hidden workspaces are left out of the grid, the feed and the counts (TRD §3.12). Their notifications and
  // permission requests are unchanged; only this page's lists drop them.
  const visibleWorkspaces = workspaces.filter((ws) => !ws.hidden)
  const hiddenWorkspaces = workspaces.filter((ws) => ws.hidden)
  const hiddenNeedAttention = hiddenWorkspaces.filter((ws) => ws.status === 'attention').length
  const hiddenIds = useMemo(() => new Set(workspaces.filter((ws) => ws.hidden).map((ws) => ws.slug)), [workspaces])
  const feedItems = useMemo(
    () => activityItems.filter((item) => isUnattributed(item.workspace) || !hiddenIds.has(item.workspace)),
    [activityItems, hiddenIds],
  )

  const registryEmpty = loaded && workspaces.length === 0
  const allHidden = workspaces.length > 0 && visibleWorkspaces.length === 0
  const showHooksBanner = eventsEnabled === false

  function handleShellButtonClick(): void {
    if (sessionState === 'none') {
      void spawnShell(SHELL_HOUSE_ID)
    } else if (overlayVisible) {
      hideOverlay(SHELL_SESSION_KEY)
    } else {
      showOverlay(SHELL_SESSION_KEY)
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content area */}
      <main className="relative flex-1 overflow-y-auto p-6">
        {/* Shell button — top-right of main column */}
        <div className="flex justify-end mb-4">
          <button
            type="button"
            onClick={handleShellButtonClick}
            className={[
              'px-3 py-1.5 rounded-md text-[13px] font-medium border transition-colors',
              overlayVisible
                ? 'bg-co-accent/10 text-co-accent border-co-accent/40'
                : 'bg-co-bg-tertiary text-co-text-secondary border-co-border hover:text-co-text-primary',
            ].join(' ')}
            aria-label="Open shell terminal"
          >
            Shell
          </button>
        </div>

        {/* A repaired or relocated settings file (the empty prompt shows the same notice itself). */}
        {!registryEmpty && (
          <div className="mb-5 empty:hidden">
            <StoreHealthNotice />
          </div>
        )}

        {/* Hooks banner — subtle, not alarming */}
        {showHooksBanner && (
          <div className="mb-5 co-glass rounded-co px-4 py-3 text-[13px] text-co-text-secondary co-animate-in">
            Install hooks to start seeing live activity.{' '}
            <button
              onClick={() => navigate('/settings')}
              className="text-co-accent hover:text-co-accent/80 transition-colors focus-visible:outline-none"
            >
              Go to Settings &rarr; Hooks
            </button>
          </div>
        )}

        {registryEmpty ? (
          <>
            <EmptyWorkspacesPrompt skin="office" onCreate={() => setCreating(true)} onOpenWorkspace={(slug) => navigate(`/workspace/${slug}`)} />
            <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} onCreated={(ws) => navigate(`/workspace/${ws.slug}`)} />
          </>
        ) : allHidden ? (
          <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
            <p className="text-co-text-muted text-sm">All your workspaces are hidden.</p>
            <button
              type="button"
              onClick={requestShowHidden}
              className="px-3 py-1.5 rounded-md text-[13px] font-medium bg-co-bg-tertiary text-co-text-secondary border border-co-border hover:text-co-text-primary transition-colors"
            >
              Show hidden
            </button>
          </div>
        ) : (
          <div
            className="grid gap-3 co-stagger"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
          >
            {visibleWorkspaces.map((ws) => (
              <WorkspaceCard key={ws.slug} workspace={ws} />
            ))}
          </div>
        )}

        {/* "N hidden · Show": opens the sidebar's Hidden section (expanding it first when it is collapsed) and focuses it. */}
        {hiddenWorkspaces.length > 0 && !allHidden && (
          <p className="mt-4 text-xs text-co-text-muted">
            {hiddenWorkspaces.length} hidden
            {hiddenNeedAttention > 0 && ` · ${hiddenNeedAttention} needs attention`}
            {' · '}
            <button type="button" onClick={requestShowHidden} className="text-co-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-co-accent rounded">
              Show
            </button>
          </p>
        )}

        {/* Terminal overlay — shell session */}
        {overlayVisible && (sessionState === 'starting' || sessionState === 'running') && (
          <TerminalOverlay
            workspaceSlug={SHELL_SESSION_KEY}
            workspaceName=""
            label="Shell"
            fontSize={terminalFontSize}
            windowBounds={terminalShellBounds}
            onBoundsChange={(bounds) => {
              void updateConfig({ terminal: { windowBounds: { shell: bounds } } } as Parameters<typeof updateConfig>[0])
            }}
            onHide={() => hideOverlay(SHELL_SESSION_KEY)}
          />
        )}
      </main>

      {/* Activity feed — right panel */}
      <aside
        className="w-80 shrink-0 border-l border-white/[0.04] flex flex-col bg-co-bg-primary/50"
        aria-label="Activity feed"
      >
        <header className="px-5 py-3.5 border-b border-white/[0.04]">
          <h2 className="text-[13px] font-semibold text-co-text-primary tracking-tight">Activity</h2>
        </header>

        <div ref={feedContainerRef} className="flex-1 overflow-hidden">
          {showHooksBanner ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
              <p className="text-co-text-muted text-[13px] leading-relaxed">
                Install hooks to see live activity here.
              </p>
              <button
                onClick={() => navigate('/settings')}
                className="mt-2 text-[12px] text-co-accent hover:text-co-accent/80 transition-colors focus-visible:outline-none"
              >
                Go to Settings
              </button>
            </div>
          ) : feedItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
              <p className="text-co-text-muted text-[13px] leading-relaxed">
                Your workspaces are being watched. Activity will appear here as Rix works.
              </p>
            </div>
          ) : (
            <ActivityFeed items={feedItems} height={feedHeight} />
          )}
        </div>
      </aside>
    </div>
  )
}
