import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { RecreatePlan } from '@main/types/sandbox'
import { useSandboxStore } from '../../stores/sandbox-store'
import { ReviewSafeName } from '../code/ReviewSafeName'
import { DisabledReason } from '../shared/DisabledReason'
import {
  describeRecreatePlan,
  CACHES_RESET_COPY,
  MEMORY_MD_WARNING_COPY,
  READ_ONLY_PROTECTIONS_COPY,
  RECREATE_FAILURE_COPY,
  SANDBOX_UNAVAILABLE_COPY,
} from '../../utils/sandbox-copy'

// ---------------------------------------------------------------------------
// RecreateDialog — the confirm-first dialog for recreating (or first creating)
// a sandbox container (TRD §3.16, §14.5 #3, B-M2, H1, SEC-H1, B-H2, UX-M1).
// Shared by the chooser (RECREATE_REQUIRED, PORT_CONFLICT) and SandboxActions.
//
// It shows WHY (one line per plan reason, including `new-container`, where
// nothing is removed) and WHAT CHANGES ON THE HOST. That second part branches
// on `readonly`: when every new mount is read-only it says only that
// read-only protections were added and lists no path; otherwise every new
// read-write host mount is listed with its full path and its source, plus the
// memory.md warning when that is the source (the sandbox agent can edit that
// file). Paths are host strings an agent may have influenced, so they render
// through ReviewSafeName.
//
// Confirm calls `recreate(slug, newPort, plan.specHash)`: the hash ties the
// action to the plan the user actually saw. If main reports PLAN_CHANGED the
// dialog reopens with the new plan and says so; Cancel changes nothing. A
// successful recreate never starts a session — the caller shows Start.
// ---------------------------------------------------------------------------

export interface RecreateDialogProps {
  slug: string
  plan: RecreatePlan
  /** Pick a new channel port as part of the recreate (PORT_CONFLICT). */
  newPort?: boolean
  skin?: 'office' | 'realm'
  /** The recreate went through. The user presses Start next; nothing starts here. */
  onRecreated: () => void
  onCancel: () => void
}

const SOURCE_LABEL: Record<RecreatePlan['newHostMounts'][number]['source'], string> = {
  settings: 'Settings',
  'memory.md': '.rix/memory.md',
  app: 'Corner Office',
}

const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#c9a84c]'

export function RecreateDialog({ slug, plan: initialPlan, newPort = false, skin = 'office', onRecreated, onCancel }: RecreateDialogProps): React.ReactElement {
  const recreate = useSandboxStore((s) => s.recreate)
  const fetchStatus = useSandboxStore((s) => s.fetchStatus)
  const [plan, setPlan] = useState(initialPlan)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const bodyId = useId()
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
        return
      }
      if (e.key !== 'Tab') return
      const cancel = cancelRef.current
      const confirm = confirmRef.current
      if (!cancel || !confirm) return
      if (e.shiftKey && document.activeElement === cancel) {
        e.preventDefault()
        confirm.focus()
      } else if (!e.shiftKey && document.activeElement === confirm) {
        e.preventDefault()
        cancel.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const description = describeRecreatePlan(plan)
  const creating = plan.reason === 'new-container'

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await recreate(slug, newPort, plan.specHash)
      if (result.ok) {
        onRecreated()
        return
      }
      if (result.code === 'PLAN_CHANGED') {
        // Reopen with the plan as it is now, so the user confirms what will actually happen.
        await fetchStatus(slug)
        const fresh = useSandboxStore.getState().status[slug]?.recreatePlan ?? null
        if (fresh) {
          setPlan(fresh)
          setNotice(RECREATE_FAILURE_COPY.PLAN_CHANGED)
          // Keep Enter from confirming the new plan before it has been read.
          cancelRef.current?.focus()
        } else {
          setError(RECREATE_FAILURE_COPY.PLAN_CHANGED)
        }
        return
      }
      setError(RECREATE_FAILURE_COPY[result.code])
    } catch {
      setError(SANDBOX_UNAVAILABLE_COPY)
    } finally {
      setBusy(false)
    }
  }

  const panelClass = isRealm ? '' : 'relative mx-4 w-full max-w-md space-y-3 rounded-xl border border-co-border bg-co-bg-primary p-6 text-sm text-co-text-primary shadow-2xl'
  const panelStyle: React.CSSProperties | undefined = isRealm
    ? { position: 'relative', background: 'rgba(10,6,2,0.92)', border: '1px solid #c9a84c', borderRadius: 4, color: '#e8dcc8', fontFamily: 'serif', padding: '24px 28px', maxWidth: 480, width: '100%' }
    : undefined
  const buttonClass = `rounded px-4 py-2 text-sm ${FOCUS} ${isRealm ? '' : 'bg-co-bg-tertiary text-co-text-primary hover:bg-co-bg-elevated'}`
  const buttonStyle: React.CSSProperties | undefined = isRealm ? { background: 'rgba(201,168,76,0.15)', border: '1px solid #c9a84c', color: '#c9a84c', fontFamily: 'serif' } : undefined

  return (
    <dialog ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onCancel={(e) => e.preventDefault()} className="co-confirm-dialog">
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
        <div className={panelClass} style={panelStyle}>
          <h2 id={titleId} className="text-sm font-semibold">
            {creating ? 'Create the sandbox?' : 'Recreate the sandbox?'}
          </h2>

          <div id={bodyId} className="space-y-2">
            {notice && (
              <p role="status" className="font-medium">
                {notice}
              </p>
            )}

            <p>{description.reasonLine}</p>

            {description.readOnlyOnly && <p>{READ_ONLY_PROTECTIONS_COPY}</p>}

            {description.readWriteMounts.length > 0 && (
              <div>
                <p className="font-medium">The sandbox will be able to write to these folders on your computer:</p>
                <ul className="mt-1 space-y-2">
                  {description.readWriteMounts.map((mount) => (
                    <li key={mount.path}>
                      <div className="break-all font-mono text-xs">
                        <ReviewSafeName name={mount.path} />
                      </div>
                      <div className="text-xs opacity-80">Source: {SOURCE_LABEL[mount.source]}</div>
                      {mount.memoryMdWarning && <p className="text-xs font-medium">{MEMORY_MD_WARNING_COPY}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!creating && description.removedMounts.length > 0 && (
              <div>
                <p className="font-medium">No longer shared with the sandbox:</p>
                <ul className="mt-1 space-y-1">
                  {description.removedMounts.map((path) => (
                    <li key={path} className="break-all font-mono text-xs">
                      <ReviewSafeName name={path} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {description.cachesReset && <p>{CACHES_RESET_COPY}</p>}

            {error && <p role="alert">{error}</p>}
          </div>

          <div className="flex justify-end gap-2">
            <button ref={cancelRef} type="button" className={buttonClass} style={buttonStyle} onClick={onCancel}>
              Cancel
            </button>
            <DisabledReason reason={busy ? 'Working…' : null} skin={skin}>
              {(props) => (
                <button ref={confirmRef} type="button" className={buttonClass} style={buttonStyle} onClick={() => void confirm()} {...props}>
                  {creating ? 'Create' : 'Recreate'}
                </button>
              )}
            </DisabledReason>
          </div>
        </div>
      </div>
    </dialog>
  )
}
