import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DeletePreview, HandOffResult } from '@main/types/sandbox'
import { useSandboxStore } from '../../stores/sandbox-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { DisabledReason } from '../shared/DisabledReason'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { RefName } from '../code/RefName'
import { RecreateDialog } from './RecreateDialog'
import { DELETE_FAILURE_COPY, HAND_OFF_FAILURE_COPY, RECREATE_FAILURE_COPY, RECREATED_COPY, SANDBOX_UNAVAILABLE_COPY, STILL_STOPPING, isSessionStopping } from '../../utils/sandbox-copy'

// ---------------------------------------------------------------------------
// SandboxActions — Hand off branch, Delete sandbox and Recreate (TRD §3.15.2,
// §3.16, H-B2, UX-C2). Skin-agnostic logic with a `skin` prop for chrome only;
// the copy is plain and identical in both skins.
//
// Every destructive or surprising action asks first (§3.16): a dirty hand-off
// and Delete go through a confirm, Recreate always goes through
// RecreateDialog. Every control is disabled with a reason (never a bare
// `disabled`) while the sandbox is still `ending`.
// ---------------------------------------------------------------------------

export interface SandboxActionsProps {
  slug: string
  skin?: 'office' | 'realm'
  /** Only Delete (the Settings → Sandboxes rows): no Hand off or Recreate. */
  deleteOnly?: boolean
  /** Only Recreate (the "sandboxes use the previous image" prompt in Settings → Image). */
  recreateOnly?: boolean
  /** Names the workspace in the Delete and Recreate buttons' accessible names when several rows share a page. */
  label?: string
}

const HANDED_OFF_COPY = 'Handed off. The branch is free to check out.'
const SESSION_NOTE = "The agent's next commits won't be on this branch."
const DELETE_BRANCHES_COPY = 'These branches stay in your repository; review or merge them first.'

/** Used to ask main for the current plan when only `recreatePending` is known: no real plan hash can equal it, so main answers PLAN_CHANGED and exposes the plan in the status. */
const PLAN_PROBE_HASH = '0'.repeat(64)

const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#c9a84c]'
const REALM_BUTTON_STYLE: React.CSSProperties = { background: 'rgba(201,168,76,0.15)', border: '1px solid #c9a84c', color: '#c9a84c', fontFamily: 'serif' }

type Feedback = { tone: 'status' | 'alert'; text: string; retry?: () => void } | null

function handOffMessage(result: Exclude<HandOffResult, { ok: true } | { code: 'DIRTY' }>): string {
  return HAND_OFF_FAILURE_COPY[result.code] ?? ''
}

export function SandboxActions({ slug, skin = 'office', deleteOnly = false, recreateOnly = false, label }: SandboxActionsProps): React.ReactElement | null {
  const status = useSandboxStore((s) => s.status[slug])
  const fetchStatus = useSandboxStore((s) => s.fetchStatus)
  const handOff = useSandboxStore((s) => s.handOff)
  const previewDelete = useSandboxStore((s) => s.previewDelete)
  const deleteSandbox = useSandboxStore((s) => s.deleteSandbox)
  const recreate = useSandboxStore((s) => s.recreate)
  const portConflict = useTerminalStore((s) => s.spawnFailure[slug] === 'PORT_CONFLICT')
  const clearSpawnError = useTerminalStore((s) => s.clearSpawnError)

  const [feedback, setFeedback] = useState<Feedback>(null)
  const [dirtyHandOff, setDirtyHandOff] = useState<number | null>(null)
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null)
  const [recreateOpen, setRecreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetchStatus(slug)
  }, [slug, fetchStatus])

  if (!status) return null

  const state = status.session.state
  const ending = isSessionStopping(state)
  const idle = state === 'idle'
  const plan = status.recreatePlan
  const showRecreate = !deleteOnly && (status.recreatePending || plan !== null || portConflict)
  const showDelete = !recreateOnly && status.exists && idle
  const showHandOff = !deleteOnly && !recreateOnly && status.worktree !== 'absent'

  const handOffReason = busy
    ? 'Working…'
    : ending
      ? STILL_STOPPING
      : status.worktree !== 'ready'
        ? HAND_OFF_FAILURE_COPY.NO_WORKTREE
        : status.git && status.git.branch === null
          ? HAND_OFF_FAILURE_COPY.NOT_ON_BRANCH
          : null
  const deleteReason = busy ? 'Working…' : ending ? STILL_STOPPING : null
  const recreateReason = busy ? 'Working…' : ending ? STILL_STOPPING : !idle ? RECREATE_FAILURE_COPY.SESSION_RUNNING : null

  async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true)
    setFeedback(null)
    try {
      return await work()
    } catch {
      setFeedback({ tone: 'alert', text: SANDBOX_UNAVAILABLE_COPY })
      return null
    } finally {
      setBusy(false)
    }
  }

  async function runHandOff(allowDirty: boolean): Promise<void> {
    const result = await attempt(() => handOff(slug, allowDirty))
    if (!result) return
    if (result.ok) {
      setFeedback({ tone: 'status', text: HANDED_OFF_COPY })
    } else if (result.code === 'DIRTY') {
      setDirtyHandOff(result.dirtyCount)
    } else if (result.code === 'LOCKED') {
      setFeedback({ tone: 'alert', text: HAND_OFF_FAILURE_COPY.LOCKED ?? '', retry: () => void runHandOff(allowDirty) })
    } else {
      setFeedback({ tone: 'alert', text: handOffMessage(result) })
    }
  }

  async function openDelete(): Promise<void> {
    const preview = await attempt(() => previewDelete(slug))
    if (!preview) return
    if (preview.sessionRunning) {
      setFeedback({ tone: 'alert', text: DELETE_FAILURE_COPY.SESSION_RUNNING })
      return
    }
    setDeletePreview(preview)
  }

  async function confirmDelete(acknowledgeDirty: boolean): Promise<void> {
    setDeletePreview(null)
    const result = await attempt(() => deleteSandbox(slug, acknowledgeDirty))
    if (!result) return
    if (!result.ok) setFeedback({ tone: 'alert', text: DELETE_FAILURE_COPY[result.code] })
  }

  async function openRecreate(): Promise<void> {
    if (plan) {
      setRecreateOpen(true)
      return
    }
    // Only `recreatePending` is known (the plan is worked out at start): ask main for it without changing anything.
    await attempt(() => recreate(slug, false, PLAN_PROBE_HASH))
    await fetchStatus(slug)
    if (useSandboxStore.getState().status[slug]?.recreatePlan) setRecreateOpen(true)
    else setFeedback({ tone: 'alert', text: SANDBOX_UNAVAILABLE_COPY })
  }

  const buttonClass = `rounded px-3 py-1.5 text-sm ${FOCUS} ${skin === 'realm' ? '' : 'border border-co-border bg-co-bg-tertiary text-co-text-primary hover:bg-co-bg-elevated'}`
  const buttonStyle = skin === 'realm' ? REALM_BUTTON_STYLE : undefined

  if (!showHandOff && !showDelete && !showRecreate) return null

  return (
    <div className="space-y-2 text-sm">
      <div role="group" aria-label="Sandbox actions" className="flex flex-wrap items-center gap-2">
        {showHandOff && (
          <DisabledReason reason={handOffReason} skin={skin}>
            {(props) => (
              <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void runHandOff(false)} {...props}>
                Hand off branch
              </button>
            )}
          </DisabledReason>
        )}

        {showRecreate && (
          <DisabledReason reason={recreateReason} skin={skin}>
            {(props) => (
              <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void openRecreate()} aria-label={label ? `Recreate sandbox for ${label}` : undefined} {...props}>
                Recreate sandbox
              </button>
            )}
          </DisabledReason>
        )}

        {showDelete && (
          <DisabledReason reason={deleteReason} skin={skin}>
            {(props) => (
              <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void openDelete()} aria-label={label ? `Delete sandbox for ${label}` : undefined} {...props}>
                Delete sandbox
              </button>
            )}
          </DisabledReason>
        )}
      </div>

      {feedback && (
        <div role={feedback.tone === 'alert' ? 'alert' : 'status'} className="flex items-center gap-2 text-xs">
          <span>{feedback.text}</span>
          {feedback.retry && (
            <button type="button" className={buttonClass} style={buttonStyle} onClick={feedback.retry}>
              Retry
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={dirtyHandOff !== null}
        title="Hand off with uncommitted changes?"
        message={`${dirtyHandOff} uncommitted ${dirtyHandOff === 1 ? 'change' : 'changes'} will stay in the sandbox worktree, not on the branch. Hand off anyway?${state === 'running' ? ` ${SESSION_NOTE}` : ''}`}
        confirmLabel="Hand off anyway"
        cancelLabel="Cancel"
        onConfirm={() => {
          setDirtyHandOff(null)
          void runHandOff(true)
        }}
        onCancel={() => setDirtyHandOff(null)}
        skin={skin}
      />

      {deletePreview && <DeleteDialog preview={deletePreview} skin={skin} onConfirm={(ack) => void confirmDelete(ack)} onCancel={() => setDeletePreview(null)} />}

      {recreateOpen && plan && (
        <RecreateDialog
          slug={slug}
          plan={plan}
          newPort={portConflict && plan.reason === 'port'}
          skin={skin}
          onRecreated={() => {
            setRecreateOpen(false)
            clearSpawnError(slug)
            setFeedback({ tone: 'status', text: RECREATED_COPY })
          }}
          onCancel={() => setRecreateOpen(false)}
        />
      )}
    </div>
  )
}

// ── Delete confirm ──────────────────────────────────────────────────────────

function DeleteDialog({
  preview,
  skin,
  onConfirm,
  onCancel,
}: {
  preview: DeletePreview
  skin: 'office' | 'realm'
  onConfirm: (acknowledgeDirty: boolean) => void
  onCancel: () => void
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [understood, setUnderstood] = useState(false)
  const titleId = useId()
  const bodyId = useId()
  const dirty = preview.dirtyCount > 0
  const isRealm = skin === 'realm'

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  // Cancel is the safe default focus.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const panelClass = isRealm ? '' : 'relative mx-4 w-full max-w-md space-y-3 rounded-xl border border-co-border bg-co-bg-primary p-6 text-sm text-co-text-primary shadow-2xl'
  const panelStyle: React.CSSProperties | undefined = isRealm
    ? { position: 'relative', background: 'rgba(10,6,2,0.92)', border: '1px solid #c9a84c', borderRadius: 4, color: '#e8dcc8', fontFamily: 'serif', padding: '24px 28px', maxWidth: 480, width: '100%' }
    : undefined
  const buttonClass = `rounded px-4 py-2 text-sm ${FOCUS} ${isRealm ? '' : 'bg-co-bg-tertiary text-co-text-primary hover:bg-co-bg-elevated'}`
  const confirmBlocked = dirty && !understood ? 'Tick "I understand" first.' : null

  return (
    <dialog ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onCancel={(e) => e.preventDefault()} className="co-confirm-dialog">
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
        <div className={panelClass} style={panelStyle}>
          <h2 id={titleId} className="text-sm font-semibold">
            Delete the sandbox?
          </h2>
          <div id={bodyId} className="space-y-2">
            <p>This removes the sandbox container and its worktree.</p>

            {preview.unmergedBranches.length > 0 && (
              <div>
                <p>{DELETE_BRANCHES_COPY}</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {preview.unmergedBranches.map((branch, i) => (
                    <li key={`${i}:${branch}`}>
                      <RefName name={branch} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {dirty && (
              <div className="space-y-1">
                <p className="font-medium">
                  {preview.dirtyCount} uncommitted {preview.dirtyCount === 1 ? 'change' : 'changes'} will be lost.
                </p>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand
                </label>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button ref={cancelRef} type="button" className={buttonClass} style={isRealm ? REALM_BUTTON_STYLE : undefined} onClick={onCancel}>
              Cancel
            </button>
            <DisabledReason reason={confirmBlocked} skin={skin}>
              {(props) => (
                <button ref={confirmRef} type="button" className={buttonClass} style={isRealm ? REALM_BUTTON_STYLE : undefined} onClick={() => onConfirm(dirty)} {...props}>
                  Delete
                </button>
              )}
            </DisabledReason>
          </div>
        </div>
      </div>
    </dialog>
  )
}
