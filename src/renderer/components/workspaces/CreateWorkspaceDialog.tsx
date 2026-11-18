import React, { useId, useRef, useState } from 'react'
import { WORKSPACE_NAME_RE } from '@main/types/slugs'
import type { Workspace } from '@main/types/workspace'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { homeRelative, inferHomeDir } from '../../utils/display-path'
import { workspaceErrorMessage } from '../../utils/workspace-errors'
import { readLastParent, rememberLastParent } from '../../utils/workspace-prefs'
import { DialogShell } from '../shared/DialogShell'

// ---------------------------------------------------------------------------
// CreateWorkspaceDialog — "New workspace…" (#0039, TRD §4.2, UX H5, H-5, L-1, M3). A dialog on the shared DialogShell;
// both skins use it, and its chrome comes from the `--co-*` tokens the realm overrides on the wrapper around it.
//
// The user picks a parent folder and a name; main creates `<parent>/<name>` and, in Rix mode, the `.rix/` scaffold and
// a first git commit. A git problem is NOT an error here: the workspace exists, and the warning stays on its row
// (CreateWarningNotice) until dismissed. A real failure (the name is taken, the parent is refused) shows inline.
// ---------------------------------------------------------------------------

type CreateMode = 'rix' | 'plain'

export interface CreateWorkspaceDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the new workspace just before the dialog closes. */
  onCreated?: (workspace: Workspace) => void
}

/** What the id will look like: the name without anything the event key drops. "My App" shows as "MyApp". */
function sanitizedId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '')
}

function isValidName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name) && name !== '.' && name !== '..'
}

export function CreateWorkspaceDialog({ open, onClose, onCreated }: CreateWorkspaceDialogProps): React.ReactElement | null {
  if (!open) return null
  return <CreateWorkspaceForm onClose={onClose} onCreated={onCreated} />
}

/** The form lives apart so each opening starts from fresh state (and the last parent is read once, on open). */
function CreateWorkspaceForm({ onClose, onCreated }: Omit<CreateWorkspaceDialogProps, 'open'>): React.ReactElement {
  const uid = useId()
  const titleId = `${uid}-title`
  const nameId = `${uid}-name`
  const hintId = `${uid}-hint`
  const nameRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  const create = useWorkspaceStore((s) => s.create)
  const pickFolder = useWorkspaceStore((s) => s.pickFolder)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  // The last parent used, else the home folder when it can be told from a registered path, else unset (Choose…).
  const [parent, setParent] = useState<string | null>(() => readLastParent() ?? inferHomeDir(workspaces.map((w) => w.path)))
  const [name, setName] = useState('')
  const [mode, setMode] = useState<CreateMode>('rix')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)

  const nameValid = isValidName(name)
  const showNameHint = name.length > 0 && !nameValid
  const canCreate = parent !== null && nameValid && !pending
  const id = sanitizedId(name)

  /** Esc, the backdrop and Cancel are ignored while a create is in flight (UX H-5): it cannot be taken back. */
  function requestClose(): void {
    if (pending) return
    onClose()
  }

  async function choose(): Promise<void> {
    setPickError(null)
    try {
      const picked = await pickFolder('create-parent')
      if (picked !== null) {
        setParent(picked)
        setError(null)
      }
    } catch (err) {
      setPickError(workspaceErrorMessage((err as { code?: string }).code))
    }
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!canCreate || parent === null || submitting.current) return // the double-submit guard
    submitting.current = true
    setPending(true)
    setError(null)
    try {
      const { workspace } = await create(parent, name, mode)
      rememberLastParent(parent)
      onCreated?.(workspace)
      onClose()
    } catch (err) {
      setError(workspaceErrorMessage((err as { code?: string }).code))
      setPending(false)
    } finally {
      submitting.current = false
    }
  }

  const field = 'w-full px-3 py-1.5 rounded bg-co-bg-tertiary border border-white/[0.04] text-sm text-co-text-primary focus:outline-none focus:border-co-accent disabled:opacity-60'
  const secondaryButton = 'px-4 py-2 text-sm text-co-text-secondary hover:text-co-text-primary bg-co-bg-tertiary rounded-lg transition-colors disabled:opacity-50'

  return (
    <DialogShell open onCancel={requestClose} labelledBy={titleId} initialFocusRef={nameRef} className="co-create-dialog">
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={requestClose} />
        <form
          onSubmit={(e) => void submit(e)}
          aria-busy={pending}
          className="relative bg-co-bg-primary border border-co-border rounded-xl shadow-2xl p-6 w-full max-w-md mx-4 flex flex-col gap-4"
        >
          <h2 id={titleId} className="text-sm font-semibold text-co-text-primary">
            New workspace
          </h2>

          <div>
            <span className="block text-xs text-co-text-secondary mb-1">Location</span>
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate font-mono text-xs text-co-text-primary" data-testid="create-location">
                {parent === null ? 'No folder chosen' : homeRelative(parent)}
              </span>
              <button type="button" className={secondaryButton} onClick={() => void choose()} disabled={pending} aria-label="Choose location">
                Choose…
              </button>
            </div>
            {pickError && (
              <p role="alert" className="mt-1 text-xs text-co-status-attention">
                {pickError}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={nameId} className="block text-xs text-co-text-secondary mb-1">
              Name
            </label>
            <input
              id={nameId}
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              readOnly={pending}
              aria-busy={pending}
              aria-invalid={showNameHint}
              aria-describedby={showNameHint ? hintId : undefined}
              autoComplete="off"
              spellCheck={false}
              className={field}
            />
            {showNameHint && (
              <p id={hintId} className="mt-1 text-xs text-co-status-attention">
                {workspaceErrorMessage('WORKSPACE_NAME_INVALID')}
              </p>
            )}
            {parent !== null && nameValid && (
              <p className="mt-1 text-xs text-co-text-muted" data-testid="create-preview">
                Will create {homeRelative(parent)}/{name}
                {id !== name && <span> · Shown as &quot;{name}&quot;</span>}
              </p>
            )}
          </div>

          <fieldset disabled={pending} className="flex flex-col gap-2">
            <legend className="text-xs text-co-text-secondary mb-1">Type</legend>
            <label className="flex items-start gap-2 text-sm text-co-text-primary">
              <input type="radio" name={`${uid}-mode`} checked={mode === 'rix'} onChange={() => setMode('rix')} className="mt-1" />
              <span>
                Rix workspace
                <span className="block text-xs text-co-text-muted">
                  Adds .rix/ (memory, history, pipelines) and docs/ (TODO, IN_PROGRESS, DONE), runs git init on main, ignores .rix/ and makes a first commit.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-co-text-primary">
              <input type="radio" name={`${uid}-mode`} checked={mode === 'plain'} onChange={() => setMode('plain')} className="mt-1" />
              <span>
                Empty folder
                <span className="block text-xs text-co-text-muted">Just a folder. Add Rix later.</span>
              </span>
            </label>
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-co-status-attention">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={requestClose} disabled={pending}>
              Cancel
            </button>
            {/* While creating the button keeps focus, so it is aria-disabled rather than disabled. */}
            <button
              type="submit"
              disabled={!canCreate && !pending}
              aria-disabled={!canCreate}
              className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent hover:bg-co-accent/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {pending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </DialogShell>
  )
}
