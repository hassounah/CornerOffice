import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { DiscoveryExclusionSchema } from '@main/types/slugs'
import type { DiscoverCandidate, DiscoverResult } from '@main/services/workspace-discover'
import type { Workspace } from '@main/types/workspace'
import { DialogShell } from '../shared/DialogShell'
import { useDiscoveryStore } from '../../stores/discovery-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { IpcError } from '../../utils/ipc'
import { DISCOVER_NO_RESULTS_COPY, DISCOVER_SUBTITLE, UNKNOWN_ERROR_COPY, workspaceErrorMessage } from '../../utils/workspace-errors'
import { ANNOUNCE_THROTTLE_MS, LIVE_ROW_LIMIT, MAX_WORKSPACES, plural, remainingCapacity } from '../../utils/workspace-limits'

// ---------------------------------------------------------------------------
// DiscoverDialog (#0039 step 4.4, TRD §4.6, UX H-1..H-4, M-5, M-6, L-3).
//
// A dialog on the shared DialogShell; both skins use it. Its chrome comes from the `--co-*` tokens, which the realm
// overrides on the wrapper around it (custom properties inherit through the DOM, top layer or not), so there is no
// `skin` prop.
//
// Running: a throttled status region, an indeterminate bar, Cancel, and candidates streaming in (the first 200 shown).
// Done: a checklist with Select all/none, capacity, per-status header and notes, and "Add N workspaces".
// Esc or closing during a scan cancels it; the partial result is kept in the discovery store ("Last scan").
// ---------------------------------------------------------------------------

export interface DiscoverDialogProps {
  open: boolean
  onClose: () => void
  /** `scan` starts a scan on open; `review` shows the last scan's result without scanning. */
  mode?: 'scan' | 'review'
  /** Called with the workspaces that were added, just before the dialog closes. */
  onAdded?: (added: Workspace[]) => void
}

/** `value`, but picked up at most once per `ms` (the first value is shown at once). */
function useThrottled(value: string, ms: number): string {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
  }, [value])
  useEffect(() => {
    const timer = setInterval(() => setShown(latest.current), ms)
    return () => clearInterval(timer)
  }, [ms])
  return shown
}

function headerFor(result: DiscoverResult): { text: string; tone: 'normal' | 'warn' | 'error' } {
  switch (result.status) {
    case 'complete':
      return { text: `Found ${plural(result.candidates.length, 'workspace')} in ${plural(result.dirsScanned, 'folder')}.`, tone: 'normal' }
    case 'timed-out':
      return { text: 'Stopped after 2 minutes. Showing what was found so far.', tone: 'warn' }
    case 'cancelled':
      return { text: 'Cancelled. Showing what was found so far.', tone: 'normal' }
    case 'error':
      return { text: "Couldn't read ~. Nothing was scanned.", tone: 'error' }
  }
}

function errorCopy(err: unknown): string {
  return err instanceof IpcError ? workspaceErrorMessage(err.code, { context: 'add' }) : UNKNOWN_ERROR_COPY
}

/**
 * The dialog mounts its body only while open, so every opening starts with fresh local state (selection, skipped
 * reasons, view) and starts its scan from an effect on mount. The focus return lives in `DialogShell`'s cleanup.
 */
export function DiscoverDialog({ open, ...rest }: DiscoverDialogProps): React.ReactElement | null {
  return open ? <DiscoverDialogBody {...rest} /> : null
}

function DiscoverDialogBody({ onClose, mode = 'scan', onAdded }: Omit<DiscoverDialogProps, 'open'>): React.ReactElement {
  const titleId = useId()
  const candidatesLabelId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const running = useDiscoveryStore((s) => s.running)
  const attached = useDiscoveryStore((s) => s.attached)
  const progress = useDiscoveryStore((s) => s.progress)
  const liveCandidates = useDiscoveryStore((s) => s.liveCandidates)
  const scanResult = useDiscoveryStore((s) => s.result)
  const lastResult = useDiscoveryStore((s) => s.lastResult)
  const scanError = useDiscoveryStore((s) => s.error)
  const attachedEnded = useDiscoveryStore((s) => s.attachedEnded)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const adding = useWorkspaceStore((s) => s.pending.has('addMany'))

  const [view, setView] = useState<'scan' | 'review'>(mode)
  /** The user's ticks, tied to the result they were made on: a different result starts from the default again. */
  const [picked, setPicked] = useState<{ result: DiscoverResult | null; paths: ReadonlySet<string> } | null>(null)
  const [skipped, setSkipped] = useState<ReadonlyMap<string, string>>(new Map())
  const [addError, setAddError] = useState<string | null>(null)
  /** Set when an add had skips: the dialog stays open on the reasons, and Done hands the added workspaces on. */
  const [partialAdd, setPartialAdd] = useState<{ added: Workspace[]; skippedCount: number } | null>(null)

  // Opening the dialog in scan mode starts the scan; the opener does not.
  useEffect(() => {
    if (mode === 'scan') void useDiscoveryStore.getState().start()
  }, [mode])

  const result: DiscoverResult | null = view === 'review' ? lastResult : scanResult
  const registeredByPath = useMemo(() => new Map(workspaces.map((w) => [w.path, w])), [workspaces])
  const remaining = remainingCapacity(workspaces.length)

  const registeredName = (c: DiscoverCandidate): string | null => {
    const byPath = registeredByPath.get(c.path)
    if (byPath) return byPath.displayName
    if (!c.alreadyRegistered) return null
    return workspaces.find((w) => w.slug === c.registeredId)?.displayName ?? c.registeredId ?? 'a workspace'
  }
  const isRegistered = (c: DiscoverCandidate): boolean => c.alreadyRegistered || registeredByPath.has(c.path)

  const selectable = useMemo(() => (result ? result.candidates.filter((c) => !c.alreadyRegistered && !registeredByPath.has(c.path)) : []), [result, registeredByPath])

  // Default selection: everything addable that fits, in order. Ticks the user made on THIS result override it, so a
  // changing workspace list or capacity never wipes them, and a new result (or Review) starts over.
  const defaultSelected = useMemo(() => new Set(selectable.slice(0, remaining).map((c) => c.path)), [selectable, remaining])
  const selected: ReadonlySet<string> = picked !== null && picked.result === result ? picked.paths : defaultSelected

  // A scan this window only followed has ended and main sent no result: say so, and show what streamed in.
  const followedScanEnded = !running && !result && view === 'scan' && attachedEnded
  const showLive = running || (!result && view === 'scan' && !scanError && !followedScanEnded)

  const requestClose = (): void => {
    const store = useDiscoveryStore.getState()
    if (store.running) void store.cancel()
    else store.reset()
    onClose()
  }

  const pick = (paths: ReadonlySet<string>): void => setPicked({ result, paths })
  const toggle = (path: string, checked: boolean): void => {
    const next = new Set(selected)
    if (checked) next.add(path)
    else next.delete(path)
    pick(next)
  }
  const selectAll = (): void => pick(new Set(selectable.slice(0, remaining).map((c) => c.path)))
  const selectNone = (): void => pick(new Set())

  const add = async (): Promise<void> => {
    if (!result) return
    const paths = result.candidates.filter((c) => selected.has(c.path)).map((c) => c.path)
    if (paths.length === 0) return
    setAddError(null)
    try {
      const { added, skipped: skippedPaths } = await useWorkspaceStore.getState().addMany(paths)
      setSkipped(new Map(skippedPaths.map((s) => [s.path, workspaceErrorMessage(s.code, { context: 'add' })])))
      if (added.length > 0 && skippedPaths.length > 0) {
        setPartialAdd({ added, skippedCount: skippedPaths.length })
      } else if (added.length > 0) {
        onAdded?.(added)
        useDiscoveryStore.getState().reset()
        onClose()
      }
    } catch (err) {
      setAddError(errorCopy(err))
    }
  }

  const finishPartialAdd = (): void => {
    if (!partialAdd) return
    onAdded?.(partialAdd.added)
    useDiscoveryStore.getState().reset()
    onClose()
  }
  const partialSummary = partialAdd ? `${partialAdd.added.length} added. ${partialAdd.skippedCount} couldn't be added.` : ''

  // ---- running view ----
  const statusText = progress
    ? `Scanning ${progress.currentDir || '…'}… ${plural(progress.dirsScanned, 'folder')} checked · ${progress.found.toLocaleString('en-US')} found`
    : 'Starting the scan…'
  const announced = useThrottled(running ? statusText : '', ANNOUNCE_THROTTLE_MS)

  const header = result ? headerFor(result) : null
  const noResults = result?.status === 'complete' && result.candidates.length === 0
  const lastDirName = result?.lastDir?.name ?? null
  const canSkipLastDir = result?.status === 'timed-out' && lastDirName !== null && DiscoveryExclusionSchema.safeParse(lastDirName).success
  const liveShown = liveCandidates.slice(0, LIVE_ROW_LIMIT)
  const liveHidden = liveCandidates.length - liveShown.length
  const toneClass = header?.tone === 'error' ? 'text-co-status-attention' : header?.tone === 'warn' ? 'text-co-status-waiting' : 'text-co-text-primary'

  return (
    <DialogShell open onCancel={requestClose} labelledBy={titleId} initialFocusRef={headingRef} className="co-discover-dialog">
      <div className="fixed inset-0 flex items-center justify-center">
        {/* A click outside must not cancel a running scan; Esc and Cancel still do. */}
        <div className="absolute inset-0 bg-black/50" onClick={running ? undefined : requestClose} />
        <div className="relative bg-co-bg-primary border border-co-border rounded-xl shadow-2xl p-6 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-co-text-primary mb-3 outline-none">
            {showLive ? 'Discover workspaces' : view === 'review' ? 'Last scan' : 'Discover workspaces'}
          </h2>

          {/* Announcements are throttled; the visible text below updates freely. */}
          <div role="status" aria-live="polite" className="sr-only">
            {running ? announced : partialSummary}
          </div>

          {(scanError || addError) && (
            <p role="alert" className="text-sm text-co-status-attention mb-3">
              {scanError ?? addError}
            </p>
          )}

          {showLive ? (
            <div className="flex flex-col min-h-0">
              <p className="text-xs text-co-text-muted mb-2">{DISCOVER_SUBTITLE}</p>
              <p className="text-sm text-co-text-secondary mb-2" aria-hidden="true">
                {statusText}
              </p>
              {attached && <p className="text-xs text-co-text-muted mb-2">A scan was already running; following it.</p>}
              <div role="progressbar" aria-label="Scanning for workspaces" className="h-1 w-full bg-co-bg-tertiary rounded overflow-hidden mb-3">
                <div className="h-full w-1/3 bg-co-accent animate-pulse" />
              </div>
              <ul className="overflow-y-auto min-h-0 flex-1 space-y-1 mb-2" aria-label="Found so far">
                {liveShown.map((c) => (
                  <li key={c.displayPath} className="text-sm">
                    <span className="text-co-text-primary">{c.name}</span>{' '}
                    <span className="text-xs text-co-text-muted">{c.displayPath}</span>
                    {c.alreadyRegistered && <span className="text-xs text-co-text-muted"> · already added</span>}
                  </li>
                ))}
              </ul>
              {liveHidden > 0 && <p className="text-xs text-co-text-muted mb-2">{liveHidden.toLocaleString('en-US')} more found</p>}
            </div>
          ) : header && result ? (
            <div className="flex flex-col min-h-0">
              <p className={`text-sm mb-1 ${toneClass}`}>{header.text}</p>
              {partialAdd && <p className="text-sm text-co-text-primary mb-1">{partialSummary}</p>}
              {noResults && <p className="text-sm text-co-text-secondary mb-1">{DISCOVER_NO_RESULTS_COPY}</p>}
              {canSkipLastDir && lastDirName && (
                <button
                  type="button"
                  className="self-start text-xs text-co-accent hover:underline mb-2"
                  onClick={() => void useDiscoveryStore.getState().setExclusionsAndRescan(lastDirName)}
                >
                  {`Skip every folder named ${lastDirName} and scan again`}
                </button>
              )}
              {result.unreadableDirs > 0 && (
                <p className="text-xs text-co-text-muted">{`${plural(result.unreadableDirs, 'folder')} couldn't be read (permissions).`}</p>
              )}
              {result.slowDirs > 0 && <p className="text-xs text-co-text-muted">{`${plural(result.slowDirs, 'folder')} didn't respond and were skipped.`}</p>}

              {result.candidates.length > 0 && (
                // A div group, not a <fieldset>: Chromium does not bound a fieldset's content box as a flex container,
                // so the list below would spill out of the dialog instead of scrolling.
                <div role="group" aria-labelledby={candidatesLabelId} className="mt-3 min-h-0 flex flex-col">
                  <p id={candidatesLabelId} className="text-xs text-co-text-secondary mb-1">
                    Workspaces to add
                  </p>
                  <p className="text-xs text-co-text-muted mb-1">
                    {`You can have at most ${MAX_WORKSPACES} workspaces (${workspaces.length} already added)`}
                  </p>
                  {view === 'review' && <p className="text-xs text-co-text-muted mb-1">Review resets your selection.</p>}
                  <div className="flex items-center gap-3 mb-2">
                    <button type="button" className="text-xs text-co-accent hover:underline" onClick={selectAll}>
                      Select all
                    </button>
                    <button type="button" className="text-xs text-co-accent hover:underline" onClick={selectNone}>
                      Select none
                    </button>
                    <span className="text-xs text-co-text-muted ml-auto" aria-live="polite">
                      {`${selected.size} of ${selectable.length} selected`}
                    </span>
                  </div>
                  <ul className="overflow-y-auto min-h-0 flex-1 space-y-1">
                    {result.candidates.map((c) => {
                      const registered = isRegistered(c)
                      const name = registeredName(c)
                      const checked = selected.has(c.path)
                      const full = !checked && selected.size >= remaining
                      const skippedReason = skipped.get(c.path)
                      return (
                        <li key={c.path} className="text-sm">
                          <label className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={checked}
                              disabled={registered || full}
                              onChange={(e) => toggle(c.path, e.target.checked)}
                            />
                            <span className="flex flex-col">
                              <span className="text-co-text-primary">
                                {c.name}
                                {c.hasGit && <span className="ml-2 text-[10px] uppercase tracking-wide border border-co-border rounded px-1 text-co-text-muted">git</span>}
                              </span>
                              <span className="text-xs text-co-text-muted">{c.displayPath}</span>
                              {registered && <span className="text-xs text-co-text-muted">{`Already added as ${name ?? 'a workspace'}`}</span>}
                              {skippedReason && <span className="text-xs text-co-status-attention">{skippedReason}</span>}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          ) : followedScanEnded ? (
            <div className="flex flex-col min-h-0">
              <p className="text-sm text-co-text-primary mb-1">The scan ended.</p>
              <p className="text-xs text-co-text-muted mb-2">
                {liveCandidates.length > 0
                  ? `It was already running when this window opened, so only what it found while you watched is shown (${plural(liveCandidates.length, 'workspace')}). Scan again for the full list.`
                  : 'It was already running when this window opened, and nothing was found while you watched. Scan again for the full list.'}
              </p>
              {liveCandidates.length > 0 && (
                <ul className="overflow-y-auto min-h-0 flex-1 space-y-1 mb-2" aria-label="Found by the scan">
                  {liveShown.map((c) => (
                    <li key={c.displayPath} className="text-sm">
                      <span className="text-co-text-primary">{c.name}</span> <span className="text-xs text-co-text-muted">{c.displayPath}</span>
                      {c.alreadyRegistered && <span className="text-xs text-co-text-muted"> · already added</span>}
                    </li>
                  ))}
                </ul>
              )}
              {liveHidden > 0 && <p className="text-xs text-co-text-muted mb-2">{liveHidden.toLocaleString('en-US')} more found</p>}
            </div>
          ) : null}

          <div className="flex gap-2 justify-end mt-4">
            {showLive ? (
              <button
                type="button"
                onClick={() => void useDiscoveryStore.getState().cancel()}
                className="px-4 py-2 text-sm text-co-text-secondary hover:text-co-text-primary bg-co-bg-tertiary rounded-lg"
              >
                Cancel
              </button>
            ) : (
              <>
                {(view === 'review' || followedScanEnded) && (
                  <button
                    type="button"
                    onClick={() => {
                      setView('scan')
                      void useDiscoveryStore.getState().start()
                    }}
                    className="px-4 py-2 text-sm text-co-text-secondary hover:text-co-text-primary bg-co-bg-tertiary rounded-lg"
                  >
                    Scan again
                  </button>
                )}
                <button
                  type="button"
                  onClick={requestClose}
                  className="px-4 py-2 text-sm text-co-text-secondary hover:text-co-text-primary bg-co-bg-tertiary rounded-lg"
                >
                  Close
                </button>
                {partialAdd ? (
                  <button
                    type="button"
                    onClick={finishPartialAdd}
                    className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent hover:bg-co-accent/20 rounded-lg"
                  >
                    Done
                  </button>
                ) : (
                  !followedScanEnded &&
                  !noResults && (
                  <button
                    type="button"
                    onClick={() => void add()}
                    disabled={running || adding || selected.size === 0}
                    className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent hover:bg-co-accent/20 rounded-lg disabled:opacity-50"
                  >
                    {adding ? 'Adding…' : `Add ${plural(selected.size, 'workspace')}`}
                  </button>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </DialogShell>
  )
}
