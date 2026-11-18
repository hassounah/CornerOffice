import React, { useEffect, useId, useRef, useState } from 'react'
import type { Workspace } from '@main/types/workspace'
import { useInlineEdit } from '../../hooks/useInlineEdit'
import { useDiscoveryStore } from '../../stores/discovery-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { homeRelative } from '../../utils/display-path'
import { AVAILABILITY_BADGE, MOVED_FOLDER_COPY, workspaceErrorMessage } from '../../utils/workspace-errors'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { RelativeTime } from '../shared/RelativeTime'
import { AddWorkspaceButton } from './AddWorkspaceButton'
import { CreateWarningNotice } from './CreateWarningNotice'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { StoreHealthNotice } from './StoreHealthNotice'

// ---------------------------------------------------------------------------
// WorkspaceManager — the registry's list, shared by the office Settings page and the realm's Settings chamber (#0039,
// TRD §4, UX M1, M-1, M-7, H-1, H-6).
//
// Rows show the name, the home-relative path and a badge; never a source or an id. Everything the user does is an
// intent (rename, set docs root, hide, remove, add): the component sends scalars and renders what main returns.
// `skin` changes behaviour, not looks: the realm has no Hide control, and its Esc on an unsaved edit must not also
// close the chamber. Both skins' chrome comes from the `--co-*` tokens.
// ---------------------------------------------------------------------------

export interface WorkspaceManagerProps {
  skin: 'office' | 'realm'
  /** Open the Discover dialog. When absent, no Discover control is shown. */
  onDiscover?: () => void
  /** Reopen the last scan's result (the "Last scan" line). */
  onReviewLastScan?: () => void
  /** A workspace was removed: office leaves its route, realm closes the Wizard's Study. */
  onRemoved?: (slug: string) => void
  /** A workspace was added or created. */
  onAdded?: (workspace: Workspace) => void
}

const smallButton = 'px-2.5 py-1 text-xs rounded border border-white/[0.04] bg-co-bg-tertiary text-co-text-secondary hover:text-co-text-primary transition-colors disabled:opacity-50'
const inputClass = 'w-full px-3 py-1.5 rounded bg-co-bg-tertiary border text-sm text-co-text-primary focus:outline-none focus:border-co-accent placeholder:text-co-text-muted'

// ---------------------------------------------------------------------------
// One editable text field (Display name, Docs root)
// ---------------------------------------------------------------------------

interface EditableFieldProps {
  id: string
  label: string
  edit: ReturnType<typeof useInlineEdit>
  mono?: boolean
  placeholder?: string
  children?: React.ReactNode
}

function EditableField({ id, label, edit, mono, placeholder, children }: EditableFieldProps): React.ReactElement {
  const errorId = `${id}-error`
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-co-text-secondary mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          {...edit.inputProps}
          placeholder={placeholder}
          // Not `disabled`: disabling the focused field drops focus to the page. Read-only while the save is in flight.
          readOnly={edit.saving}
          aria-busy={edit.saving}
          aria-invalid={edit.error !== null}
          aria-describedby={edit.error ? errorId : undefined}
          spellCheck={false}
          className={`${inputClass} ${mono ? 'font-mono text-xs' : ''} ${edit.error ? 'border-red-500' : 'border-white/[0.04]'}`}
        />
        {children}
      </div>
      {edit.error && (
        <p id={errorId} role="alert" className="text-xs text-red-400 mt-1">
          {edit.error}
        </p>
      )}
      <p role="status" aria-live="polite" className="text-xs text-co-text-muted mt-1 h-4">
        {edit.saved && !edit.error ? 'Saved' : ''}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One workspace row
// ---------------------------------------------------------------------------

interface RowProps {
  workspace: Workspace
  skin: 'office' | 'realm'
  highlighted: boolean
  onRemove: (workspace: Workspace) => void
}

function WorkspaceRow({ workspace, skin, highlighted, onRemove }: RowProps): React.ReactElement {
  const uid = useId()
  const rowRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const rename = useWorkspaceStore((s) => s.rename)
  const setDocsRoot = useWorkspaceStore((s) => s.setDocsRoot)
  const setHidden = useWorkspaceStore((s) => s.setHidden)
  const pickFolder = useWorkspaceStore((s) => s.pickFolder)
  const [hideError, setHideError] = useState<string | null>(null)
  const [browseError, setBrowseError] = useState<string | null>(null)

  const slug = workspace.slug
  const available = workspace.availability === 'ok'

  // A new row scrolls into view (UX M1). jsdom has no scrollIntoView.
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [highlighted])

  const nameEdit = useInlineEdit({
    value: workspace.displayName,
    save: (next) => rename(slug, next),
    emptyMessage: "Name can't be empty",
    skin,
    context: 'rename',
  })
  const docsEdit = useInlineEdit({
    value: workspace.docsRoot,
    save: (next) => setDocsRoot(slug, next),
    skin,
    context: 'docs-root',
  })

  async function browse(): Promise<void> {
    setBrowseError(null)
    try {
      const picked = await pickFolder('docs-root')
      if (picked !== null) await docsEdit.commit(picked)
    } catch (err) {
      setBrowseError(workspaceErrorMessage((err as { code?: string }).code))
    }
  }

  async function toggleHidden(): Promise<void> {
    setHideError(null)
    try {
      await setHidden(slug, !workspace.hidden)
    } catch (err) {
      setHideError(workspaceErrorMessage((err as { code?: string }).code))
    }
  }

  return (
    <div
      ref={rowRef}
      data-testid={`workspace-row-${slug}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={`rounded-lg border transition-colors ${highlighted ? 'border-co-accent bg-co-accent/5' : 'border-white/[0.04]'} ${available ? '' : 'opacity-70'}`}
    >
      <div className="flex items-center gap-3 p-3 bg-co-bg-elevated rounded-lg">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${uid}-panel`}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${workspace.displayName}`}
          onClick={() => setExpanded((p) => !p)}
          className="text-co-text-muted hover:text-co-text-secondary transition-colors shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true">
            <path d="M4 2l4 4-4 4" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-co-text-primary truncate">{workspace.displayName}</p>
          <p className="text-xs text-co-text-muted truncate">{homeRelative(workspace.path)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!available && (
            <span className="text-xs px-2 py-0.5 rounded border border-co-status-attention/40 text-co-status-attention">{AVAILABILITY_BADGE[workspace.availability as Exclude<Workspace['availability'], 'ok'>]}</span>
          )}
          {skin === 'office' && workspace.hidden && <span className="text-xs px-2 py-0.5 rounded border border-white/[0.04] text-co-text-muted">Hidden</span>}
        </div>
      </div>

      <CreateWarningNotice slug={slug} path={workspace.path} />

      {expanded && (
        <div id={`${uid}-panel`} className="p-3 border-t border-white/[0.04] flex flex-col gap-3 bg-co-bg-primary rounded-b-lg">
          <EditableField id={`${uid}-name`} label="Display name" edit={nameEdit} placeholder={slug} />

          <EditableField id={`${uid}-docs`} label="Docs root" edit={docsEdit} mono placeholder={`${homeRelative(workspace.path)}/docs`}>
            <button type="button" className={smallButton} onClick={() => void browse()}>
              Browse…
            </button>
            <button type="button" className={smallButton} onClick={() => void docsEdit.commit(null)}>
              Reset to default
            </button>
          </EditableField>
          {browseError && (
            <p role="alert" className="text-xs text-red-400 -mt-2">
              {browseError}
            </p>
          )}

          {skin === 'office' && (
            <div>
              <button type="button" role="switch" aria-checked={workspace.hidden} onClick={() => void toggleHidden()} className={smallButton}>
                Hide this workspace
              </button>
              <p className="text-xs text-co-text-muted mt-1">Hidden workspaces still show in the Realm.</p>
              {hideError && (
                <p role="alert" className="text-xs text-red-400 mt-1">
                  {hideError}
                </p>
              )}
            </div>
          )}

          <div>
            <button type="button" className={`${smallButton} text-red-300`} onClick={() => onRemove(workspace)}>
              Remove from Corner Office…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Remove confirmation
// ---------------------------------------------------------------------------

/** A sandbox worktree outlives the workspace's removal: say so, and where it is (UX M8). */
async function worktreeNotice(slug: string): Promise<React.ReactNode> {
  try {
    const response = (await window.cornerOffice.sandbox.getStatus(slug)) as { data: { worktree: string } | null }
    // SANDBOX_OFF_IN_PROFILE and any other error leave `data` null: counted as no worktree.
    if (!response.data || response.data.worktree === 'absent') return null
    return (
      <p className="text-xs text-co-text-muted mb-4">
        Its sandbox worktree at <code>~/.corner-office/sandboxes/{slug}</code> stays on disk. Delete it yourself if you no longer need it.
      </p>
    )
  } catch {
    return null
  }
}

export interface RemoveDialogProps {
  target: Workspace | null
  skin: 'office' | 'realm'
  onClose: () => void
  onRemoved?: (slug: string) => void
  /** Where focus goes when the row the Remove button was in disappears. */
  fallbackFocus: React.RefObject<HTMLElement | null>
}

/** The Remove confirmation, shared by the manager's rows, the office detail page and the realm's Wizard's Study. */
export function RemoveWorkspaceDialog({ target, skin, onClose, onRemoved, fallbackFocus }: RemoveDialogProps): React.ReactElement | null {
  const remove = useWorkspaceStore((s) => s.remove)
  const [error, setError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)
  const [details, setDetails] = useState<{ slug: string; node: React.ReactNode } | null>(null)

  const slug = target?.slug ?? null
  useEffect(() => {
    if (slug === null) return
    let cancelled = false
    void worktreeNotice(slug).then((node) => {
      if (!cancelled) setDetails({ slug, node })
    })
    return () => {
      cancelled = true
    }
  }, [slug])

  if (!target) return null

  async function confirm(workspace: Workspace): Promise<void> {
    if (inFlight.current) return // a double click is one removal
    inFlight.current = true
    setError(undefined)
    try {
      await remove(workspace.slug)
      onRemoved?.(workspace.slug)
      onClose()
    } catch (err) {
      // The busy codes ("A session is running in this workspace. End it first.") stay in the dialog.
      setError(workspaceErrorMessage((err as { code?: string }).code))
    } finally {
      inFlight.current = false
    }
  }

  return (
    <ConfirmDialog
      open
      skin={skin}
      title={`Remove ${target.displayName}?`}
      message={`This only removes ${target.displayName} from the list. No files are deleted.`}
      confirmLabel="Remove"
      cancelLabel="Cancel"
      details={
        <>
          {target.availability !== 'ok' && target.availability !== 'checking' && target.availability !== 'budget' && <p className="text-xs text-co-text-muted mb-4">{MOVED_FOLDER_COPY}</p>}
          {details?.slug === target.slug ? details.node : null}
        </>
      }
      error={error}
      fallbackFocus={fallbackFocus}
      onConfirm={() => void confirm(target)}
      onCancel={onClose}
    />
  )
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export function WorkspaceManager({ skin, onDiscover, onReviewLastScan, onRemoved, onAdded }: WorkspaceManagerProps): React.ReactElement {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const highlightSlug = useWorkspaceStore((s) => s.highlightSlug)
  const lastFinishedAt = useDiscoveryStore((s) => s.lastFinishedAt)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<Workspace | null>(null)
  // A stable place for focus to land when a removal deletes the row that held it (UX M-5).
  const headingRef = useRef<HTMLHeadingElement>(null)

  return (
    <section aria-label="Workspaces" className="flex flex-col gap-4">
      <StoreHealthNotice />

      <div className="flex flex-wrap items-center gap-2">
        <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-co-text-primary mr-auto outline-none">
          Workspaces ({workspaces.length})
        </h3>
        <AddWorkspaceButton onAdded={onAdded} />
        <button type="button" className={smallButton} onClick={() => setCreating(true)}>
          New workspace…
        </button>
        {onDiscover && (
          <button type="button" className={smallButton} onClick={onDiscover}>
            Discover…
          </button>
        )}
      </div>

      {lastFinishedAt !== null && (
        <p className="text-xs text-co-text-muted -mt-2">
          Last scan <RelativeTime timestamp={new Date(lastFinishedAt).toISOString()} />
          {onReviewLastScan && (
            <>
              {' · '}
              <button type="button" onClick={onReviewLastScan} className="underline hover:text-co-text-secondary">
                Review
              </button>
            </>
          )}
        </p>
      )}

      {workspaces.length === 0 ? (
        <p className="text-sm text-co-text-muted">No workspaces yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {workspaces.map((ws) => (
            <WorkspaceRow key={ws.slug} workspace={ws} skin={skin} highlighted={highlightSlug === ws.slug} onRemove={setRemoving} />
          ))}
        </div>
      )}

      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} onCreated={onAdded} />
      <RemoveWorkspaceDialog target={removing} skin={skin} onClose={() => setRemoving(null)} onRemoved={onRemoved} fallbackFocus={headingRef} />
    </section>
  )
}
