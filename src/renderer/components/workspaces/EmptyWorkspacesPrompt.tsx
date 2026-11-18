import React, { useRef, useState } from 'react'
import type { Workspace } from '@main/types/workspace'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { IpcError } from '../../utils/ipc'
import { EMPTY_COPY, UNKNOWN_ERROR_COPY, workspaceErrorMessage } from '../../utils/workspace-errors'
import { DiscoverDialog } from './DiscoverDialog'
import { LegacyNotice } from './LegacyNotice'
import { StoreHealthNotice } from './StoreHealthNotice'

// ---------------------------------------------------------------------------
// EmptyWorkspacesPrompt (#0039 step 4.4, TRD §4.7) — what replaces the first-launch wizard when the registry is empty.
// Office: the Dashboard and the Settings Workspaces tab. Realm: the first-run overlay (distinct copy, UX M7).
//
// Three actions: Discover (primary), Add folder…, New workspace…. Whatever gets added first is opened (UX M-3), so the
// user lands somewhere real. Creating is the caller's: it passes `onCreate` to open the create dialog.
// ---------------------------------------------------------------------------

export interface EmptyWorkspacesPromptProps {
  skin: 'office' | 'realm'
  /** Open the "New workspace…" dialog. */
  onCreate: () => void
  /** Open a workspace (the first one added from here). */
  onOpenWorkspace: (slug: string) => void
}

export function EmptyWorkspacesPrompt({ skin, onCreate, onOpenWorkspace }: EmptyWorkspacesPromptProps): React.ReactElement {
  const pending = useWorkspaceStore((s) => s.pending)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const discoverButtonRef = useRef<HTMLButtonElement>(null)

  const busy = pending.has('add') || pending.has('pickFolder')

  async function addFolder(): Promise<void> {
    setError(null)
    try {
      const path = await useWorkspaceStore.getState().pickFolder('add')
      if (path === null) return // cancelling the picker does nothing
      const ws = await useWorkspaceStore.getState().add(path)
      onOpenWorkspace(ws.slug)
    } catch (err) {
      setError(err instanceof IpcError ? workspaceErrorMessage(err.code, { context: 'add' }) : UNKNOWN_ERROR_COPY)
    }
  }

  function handleAdded(added: Workspace[]): void {
    if (added.length > 0) onOpenWorkspace(added[0].slug)
  }

  const secondary = 'px-4 py-2 text-sm text-co-text-secondary hover:text-co-text-primary bg-co-bg-tertiary rounded-lg transition-colors disabled:opacity-50'

  return (
    <section aria-labelledby="empty-workspaces-title" className={`flex flex-col items-center text-center gap-4 py-10 px-6 ${skin === 'realm' ? 'font-serif' : ''}`}>
      <StoreHealthNotice />
      <h2 id="empty-workspaces-title" className="text-base font-semibold text-co-text-primary max-w-md">
        {EMPTY_COPY[skin]}
      </h2>
      {/* The office skin shows the notice in AppShell; the realm's first-run overlay covers RealmShell's own, so it repeats here. */}
      {skin === 'realm' && <LegacyNotice skin="realm" />}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          ref={discoverButtonRef}
          type="button"
          onClick={() => setDiscoverOpen(true)}
          className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent hover:bg-co-accent/20 rounded-lg transition-colors"
        >
          Discover
        </button>
        <button type="button" onClick={() => void addFolder()} disabled={busy} className={secondary}>
          Add folder…
        </button>
        <button type="button" onClick={onCreate} className={secondary}>
          New workspace…
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-co-status-attention max-w-md">
          {error}
        </p>
      )}
      <DiscoverDialog open={discoverOpen} onClose={() => setDiscoverOpen(false)} onAdded={handleAdded} />
    </section>
  )
}
