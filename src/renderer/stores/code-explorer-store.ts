import { create } from 'zustand'
import { Text } from '@codemirror/state'
import type {
  CodeChange,
  CodeChangedPayload,
  CodeFileResponse,
  CodeBaselineResponse,
  CodeStatusResponse,
  RepoInfo,
} from '@main/types/code'
import type { DirListing } from '../components/code/tree-model'
import { friendlyCodeError } from '../utils/code-errors'
import { minimalChange } from '../utils/text-utils'
import { reloadedFromDiskNotice } from '../components/code/notice-copy'
import { registerDirtySource } from './dirty-registry'
import { setPendingReturnFocus } from '../utils/code-explorer-return-focus'

// ---------------------------------------------------------------------------
// code-explorer-store.ts — Zustand store (TRD §3.6.1)
//
// Step 2.6 ("A") owns session (open/close, `gen`), tree (`dirs`, `expanded`,
// `toggleDir`, `revealInTree`, `showIgnored`), status (`refreshStatus`,
// `setBaseline`, `setChangedOnly`), the file index (`loadFileIndex`) and
// live-watch wiring (the 500 ms `code:changed` coalescing and the 10 s
// visible-only poll) — 7 of the 12 §3.6.1 staleness-inventory rows:
// openExplorer, toggleDir, setShowIgnored, refreshStatus, loadFileIndex,
// closeExplorer, handleChanged (the 'git'/'dir' cases).
//
// Step 2.7 ("B") owns file/edit/save/disk-change: `openFile`, `reveal`,
// `setView`'s and `setBaseline`'s `readBaseline` fetch, `enterEdit`,
// `onDocChange`, `save`, `reloadFromDisk`, `keepMine`, and `handleChanged`'s
// 'file' case — the remaining 5 staleness rows, plus the full §3.9.2
// disk-change matrix.
//
// `draftDoc`/`baselineText` are real CodeMirror `Text` VALUES (not just the
// type) constructed and mutated here (`enterEdit`'s initial doc, the
// editing∧clean reload-in-place `Text.replace`) — `@codemirror/state` is a
// small, DOM-free data-model package, distinct from the heavier
// `@codemirror/view` the lazy-loaded editor component pulls in, so importing
// its runtime value here doesn't reintroduce the editor UI into this store's
// bundle.
// ---------------------------------------------------------------------------

export interface IpcErr {
  code: string
  message: string
}

export interface OpenExplorerOpts {
  changedOnly?: boolean
  baseline?: 'head' | 'branch'
  entry?: 'browse' | 'review'
  expectedBranch?: string | null
}

interface StatusState {
  byPath: Record<string, CodeChange>
  dirRollup: Record<string, true>
  changes: CodeChange[]
  totals: CodeStatusResponse['totals']
  truncated: boolean
  loading: boolean
  failed: boolean
  at: number
}

interface FileIndexState {
  paths: string[]
  includeIgnored: boolean
  truncated: boolean
  at: number
}

export interface CodeExplorerState {
  open: boolean
  workspaceSlug: string | null
  gen: number // session generation: bumps on openExplorer and closeExplorer; also the watch token
  repo: RepoInfo | null
  baseline: 'head' | 'branch'
  changedOnly: boolean
  showIgnored: boolean
  expectedBranch: string | null
  // A stable `data-return-focus` id (TRD §3.6.1/§3.8.1), never a cached
  // element reference: in Office, opening the explorer navigates to a new
  // route, unmounting the trigger's page (and the trigger button with it),
  // so an element reference would be detached by the time closeExplorer
  // runs. The string survives that unmount because it lives in this store,
  // not on a DOM node. Realm's overlay never unmounts its trigger, so a
  // fresh DOM lookup by this id also works there (see closeExplorer).
  returnFocus: string | null
  entry: 'browse' | 'review' | null

  dirs: Record<string, DirListing>
  expanded: Record<string, true>
  selected: string | null

  status: StatusState | null
  fileIndex: FileIndexState | null

  file: CodeFileResponse | null
  fileLoading: boolean
  fileError: IpcErr | null
  fileReq: number // per-openFile request id

  view: 'source' | 'preview' | 'changes'
  diffLayout: 'inline' | 'split'
  baselineDoc: CodeBaselineResponse | null
  revealed: boolean
  deletedPath: string | null

  editing: boolean
  dirty: boolean
  saving: boolean
  saveError: IpcErr | null
  draftDoc: Text | null
  baselineText: Text | null
  expectedMtime: string | null
  diskChange: null | { kind: 'modified'; lastModified: string } | { kind: 'deleted' }
  transientNote: string | null
  liveLimited: boolean

  // actions (unguarded; UI call sites wrap with guardAction per §3.7.2)
  openExplorer: (slug: string, opts?: OpenExplorerOpts) => void
  closeExplorer: () => void
  toggleDir: (rel: string) => void
  revealInTree: (rel: string) => void
  setBaseline: (b: 'head' | 'branch') => void
  setChangedOnly: (v: boolean) => void
  setShowIgnored: (v: boolean) => void
  refreshStatus: () => Promise<void>
  openFile: (rel: string) => void
  reveal: () => void
  setView: (v: 'source' | 'preview' | 'changes') => void
  setDiffLayout: (l: 'inline' | 'split') => void
  enterEdit: () => void
  onDocChange: (doc: Text, dirty: boolean) => void
  cancelEdit: () => void
  save: () => Promise<void>
  reloadFromDisk: () => void
  keepMine: () => void
  handleChanged: (p: CodeChangedPayload) => void
  loadFileIndex: () => Promise<void>
}

type Get = () => CodeExplorerState
type Set = (
  partial:
    | Partial<CodeExplorerState>
    | ((state: CodeExplorerState) => Partial<CodeExplorerState>),
) => void

const ZERO_TOTALS: CodeStatusResponse['totals'] = { files: 0, added: 0, removed: 0, approximate: false }

// Rule (§3.6.1): openFile, closeExplorer, a slug change and reloadFromDisk
// reset these 8 fields. openFile additionally resets `revealed` (2.7).
const EDIT_RESET = {
  editing: false,
  dirty: false,
  saving: false,
  saveError: null as IpcErr | null,
  draftDoc: null as Text | null,
  baselineText: null as Text | null,
  diskChange: null as CodeExplorerState['diskChange'],
  transientNote: null as string | null,
}

const CLOSED_STATE = {
  open: false,
  workspaceSlug: null as string | null,
  repo: null as RepoInfo | null,
  baseline: 'head' as const,
  changedOnly: false,
  showIgnored: false,
  expectedBranch: null as string | null,
  returnFocus: null as string | null,
  entry: null as 'browse' | 'review' | null,

  dirs: {} as Record<string, DirListing>,
  expanded: {} as Record<string, true>,
  selected: null as string | null,

  status: null as StatusState | null,
  fileIndex: null as FileIndexState | null,

  file: null as CodeFileResponse | null,
  fileLoading: false,
  fileError: null as IpcErr | null,
  fileReq: 0,

  view: 'source' as const,
  diffLayout: 'inline' as const,
  baselineDoc: null as CodeBaselineResponse | null,
  revealed: false,
  deletedPath: null as string | null,

  expectedMtime: null as string | null,
  liveLimited: false,
  ...EDIT_RESET,
}

function computeByPath(changes: CodeChange[]): Record<string, CodeChange> {
  const byPath: Record<string, CodeChange> = {}
  for (const c of changes) byPath[c.relPath] = c
  return byPath
}

// FR-8: every proper ancestor directory of a changed file gets a "rolled-up
// dot" so a collapsed ancestor still shows something changed inside it.
function computeDirRollup(changes: CodeChange[]): Record<string, true> {
  const rollup: Record<string, true> = {}
  for (const c of changes) {
    const segments = c.relPath.split('/')
    segments.pop()
    let acc = ''
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg
      rollup[acc] = true
    }
  }
  return rollup
}

// Shared by toggleDir (expand), setShowIgnored (refetch loaded/expanded
// dirs) and handleChanged's 'dir' case (refetch a pushed dir) — the one
// place this store calls code.listDir, guarded by gen + the requested
// showIgnored (dropped if either has since changed, §3.6.1 rows 2/3).
function fetchDir(get: Get, set: Set, workspaceSlug: string, gen: number, showIgnored: boolean, rel: string): void {
  set((s) => ({
    dirs: {
      ...s.dirs,
      [rel]: { entries: s.dirs[rel]?.entries ?? [], omitted: s.dirs[rel]?.omitted ?? 0, loading: true, error: null },
    },
  }))
  void (async () => {
    try {
      const response = await window.cornerOffice.code.listDir(workspaceSlug, rel, showIgnored)
      if (get().gen !== gen || get().showIgnored !== showIgnored) return
      if (response.error) {
        set((s) => ({
          dirs: { ...s.dirs, [rel]: { entries: [], omitted: 0, loading: false, error: friendlyCodeError(response.error) } },
        }))
        return
      }
      set((s) => ({
        dirs: {
          ...s.dirs,
          [rel]: { entries: response.data.entries, omitted: response.data.omitted, loading: false, error: null },
        },
      }))
    } catch (err) {
      if (get().gen !== gen || get().showIgnored !== showIgnored) return
      set((s) => ({
        dirs: { ...s.dirs, [rel]: { entries: [], omitted: 0, loading: false, error: friendlyCodeError(err) } },
      }))
    }
  })()
}

// Single-flight + trailing rerun (§3.6.1 refreshStatus row) and the 10 s
// visible-only poll both live outside React state — they are pure
// concurrency bookkeeping, not data a component ever renders.
let statusInFlight = false
let statusTrailingRequested = false
let gitChangeDebounce: ReturnType<typeof setTimeout> | null = null
let pollIntervalId: ReturnType<typeof setInterval> | null = null
let focusListener: (() => void) | null = null

function stopPoll(): void {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId)
    pollIntervalId = null
  }
}

// §3.6.1's refresh-trigger list (line 556): "...window focus...". Complements
// the 10 s visible-only poll below — this fires IMMEDIATELY on regaining
// focus, rather than waiting up to 10 s, so switching back to the app after
// an agent edited files elsewhere shows the change promptly (R6).
function stopFocusRefresh(): void {
  if (focusListener && typeof window !== 'undefined') {
    window.removeEventListener('focus', focusListener)
  }
  focusListener = null
}

function startFocusRefresh(get: Get): void {
  stopFocusRefresh()
  if (typeof window === 'undefined') return
  focusListener = () => {
    if (get().status?.loading) return // skip while a refresh is already in flight
    void get().refreshStatus()
  }
  window.addEventListener('focus', focusListener)
}

function startPoll(get: Get): void {
  stopPoll()
  pollIntervalId = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (get().status?.loading) return // skip while a refresh is already in flight
    void get().refreshStatus()
  }, 10_000)
}

// ---------------------------------------------------------------------------
// File/edit/save/disk-change helpers (step 2.7's "B" rows, TRD §3.6.1, §3.9.2)
// ---------------------------------------------------------------------------

/** Builds a CodeMirror Text from raw file content, first normalizing every
 *  line-ending variant to a bare split point — a Text always stores lines
 *  with no residual '\r'; the file's own EOL style is reapplied only at save
 *  time via Text.sliceString's line-separator argument (§3.6.1's save rule). */
function textFromContent(content: string): Text {
  return Text.of(content.split(/\r\n|\r|\n/))
}

// The store's OWN 4 s auto-clear for `transientNote` (§3.6.1/§3.9.2; the
// ExplorerNotice component that renders it also self-hides after autoHideMs,
// but the store's own fact must not outlive that regardless of whether any
// component is even mounted to observe it). Guarded by gen + fileReq, like
// every other async completion in this file, so a stale timer from a since-
// abandoned file/session can never clear a fresh note.
let transientNoteTimer: ReturnType<typeof setTimeout> | null = null

function scheduleTransientNoteClear(get: Get, set: Set, gen: number, fileReq: number): void {
  if (transientNoteTimer) clearTimeout(transientNoteTimer)
  transientNoteTimer = setTimeout(() => {
    transientNoteTimer = null
    if (get().gen === gen && get().fileReq === fileReq) set({ transientNote: null })
  }, 4000)
}

// Shared by setView('changes') and setBaseline when a diff is already open
// (§3.6.1 staleness row: readBaseline, guarded by gen + fileReq + baseline).
function fetchBaseline(
  get: Get,
  set: Set,
  slug: string,
  gen: number,
  fileReq: number,
  relPath: string,
  oldPath: string | undefined,
  baseline: 'head' | 'branch',
  reveal: boolean,
): void {
  void (async () => {
    try {
      const response = await window.cornerOffice.code.readBaseline(slug, relPath, baseline, reveal, oldPath)
      if (get().gen !== gen || get().fileReq !== fileReq || get().baseline !== baseline) return
      if (response.error) return // the file view itself still works; the TRD has no dedicated baseline-error surface
      set({ baselineDoc: response.data })
    } catch {
      // Same silent degrade as above.
    }
  })()
}

// Shared by handleChanged's 'file' case and save()'s STALE_WRITE branch —
// both are "something suggests the file changed on disk", so both re-fetch
// the current content and branch by the exact same §3.9.2 matrix rather than
// duplicating it. A STALE_WRITE response carries no mtime of its own
// (safe-fs's guard only reports the mismatch, not the winning value), so
// re-reading the file is also the only way to learn the real new
// lastModified in that case.
//
// `forcePersistentBanner` is set only by the STALE_WRITE call site: the
// user just tried to save (regardless of whether the draft was still
// "dirty" at that exact instant — save() doesn't require dirty), so the
// TRD's STALE_WRITE row always means the persistent banner, never the
// passive "editing ∧ clean" reload-in-place path a watcher push alone
// would take.
function handleDiskChangeDetected(
  get: Get,
  set: Set,
  slug: string,
  gen: number,
  fileReq: number,
  relPath: string,
  forcePersistentBanner = false,
): void {
  void (async () => {
    try {
      const response = await window.cornerOffice.code.readFile(slug, relPath, get().revealed)
      if (get().gen !== gen || get().fileReq !== fileReq) return

      if (response.error) {
        if (response.error.code === 'NOT_FOUND') {
          const state = get()
          if (state.editing) set({ diskChange: { kind: 'deleted' } })
          else set({ deletedPath: relPath })
        }
        // Any other error: degrade silently, keeping the last-known content.
        return
      }

      const newFile = response.data
      const state = get()

      if (!state.editing) {
        // View mode: silent reload. The minimal-change dispatch that
        // preserves scroll/selection is the source view component's job —
        // it computes minimalChange itself from the two content STRINGS;
        // the store has no Text state at all outside of editing.
        set({ file: newFile, deletedPath: null })
        return
      }

      const treatAsDirty = forcePersistentBanner || state.dirty

      if (!treatAsDirty && newFile.kind === 'text') {
        // Editing ∧ clean: reload in place, stay in Edit, transient note.
        // minimalChange + Text.replace (not a from-scratch Text.of) so the
        // new doc shares structure with the old one wherever unchanged.
        const oldText = state.baselineText ?? textFromContent('')
        const change = minimalChange(oldText.toString(), newFile.content)
        const newDoc = change ? oldText.replace(change.from, change.to, Text.of(change.insert.split('\n'))) : oldText
        set({
          file: newFile,
          baselineText: newDoc,
          draftDoc: newDoc,
          expectedMtime: newFile.lastModified,
          diskChange: null,
          transientNote: reloadedFromDiskNotice(),
        })
        scheduleTransientNoteClear(get, set, gen, fileReq)
        return
      }

      if (!treatAsDirty && newFile.kind !== 'text') {
        // The file stopped being editable text entirely (replaced with
        // binary, grew past EDIT_MAX, etc.) — nothing left to edit in place;
        // fall back to a clean view of the new content.
        set({ ...EDIT_RESET, file: newFile })
        return
      }

      // Editing ∧ (dirty, or a just-failed save): persistent banner, draft
      // stays untouched.
      set({ diskChange: { kind: 'modified', lastModified: newFile.lastModified } })
    } catch {
      // Degrade silently — the watcher will likely push again, or the user
      // can retry via the ⟳ button / the Reload banner.
    }
  })()
}

export const useCodeExplorerStore = create<CodeExplorerState>((set, get) => ({
  ...CLOSED_STATE,
  gen: 0,

  openExplorer: (slug, opts) => {
    if (gitChangeDebounce) {
      clearTimeout(gitChangeDebounce)
      gitChangeDebounce = null
    }
    const activeElement = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    const returnFocus = activeElement?.getAttribute('data-return-focus') ?? null
    const newGen = get().gen + 1
    const baseline = opts?.baseline ?? 'head'
    set({
      ...CLOSED_STATE,
      open: true,
      workspaceSlug: slug,
      gen: newGen,
      baseline,
      changedOnly: opts?.changedOnly ?? false,
      entry: opts?.entry ?? null,
      expectedBranch: opts?.expectedBranch ?? null,
      returnFocus,
    })

    fetchDir(get, set, slug, newGen, get().showIgnored, '')
    void get().refreshStatus()

    void (async () => {
      try {
        const response = await window.cornerOffice.code.watch(slug, newGen, null, [])
        if (get().gen !== newGen) return
        if (!response.error) set({ liveLimited: response.data.limited })
      } catch {
        // Live updates are a nice-to-have; a watch failure does not block the explorer.
      }
    })()

    startPoll(get)
    startFocusRefresh(get)
  },

  closeExplorer: () => {
    const state = get()
    if (!state.open) return
    const { workspaceSlug: slug, gen: oldGen, returnFocus } = state

    // Fix #141 item 3: captured here, first, rather than left to each
    // caller to remember — CLOSED_STATE's own reset (right below) clears
    // `returnFocus` to null in this SAME call, so a caller that captured it
    // AFTER calling closeExplorer() would already be too late (see
    // code-explorer-return-focus.ts for why Office's cross-route
    // restoration needs a copy that survives that reset at all). Doing it
    // here makes every current and future caller of closeExplorer() —
    // Realm's own call, step 3.1+, included — correct by construction
    // instead of a convention every caller has to separately remember.
    setPendingReturnFocus(returnFocus)

    stopPoll()
    stopFocusRefresh()
    if (gitChangeDebounce) {
      clearTimeout(gitChangeDebounce)
      gitChangeDebounce = null
    }
    set({ ...CLOSED_STATE, gen: oldGen + 1 })

    if (slug) void window.cornerOffice.code.unwatch(slug, oldGen).catch(() => {})
    // Office: the trigger's page may have unmounted (a route change) — its
    // restoration reads this id back from the store directly, once the new
    // page mounts (a future consumeReturnFocus(), step 2.21), not from here.
    // Realm's overlay never unmounts its trigger, so a fresh, un-cached DOM
    // lookup by id also works as an immediate best-effort restoration.
    if (returnFocus && typeof document !== 'undefined') {
      const id = returnFocus
      queueMicrotask(() => {
        const selector = `[data-return-focus="${CSS.escape(id)}"]`
        const el = document.querySelector<HTMLElement>(selector)
        el?.focus()
      })
    }
  },

  toggleDir: (rel) => {
    const state = get()
    if (state.expanded[rel] === true) {
      const nextExpanded = { ...state.expanded }
      delete nextExpanded[rel]
      set({ expanded: nextExpanded })
      return
    }
    set((s) => ({ expanded: { ...s.expanded, [rel]: true } }))
    if (!state.workspaceSlug) return
    const existing = state.dirs[rel]
    if (existing && !existing.loading) return // already loaded — re-expanding just shows the cache
    fetchDir(get, set, state.workspaceSlug, state.gen, state.showIgnored, rel)
  },

  revealInTree: (rel) => {
    const state = get()
    const segments = rel.split('/')
    segments.pop()
    const nextExpanded = { ...state.expanded }
    const toFetch: string[] = []
    let acc = ''
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg
      nextExpanded[acc] = true
      if (!state.dirs[acc]) toFetch.push(acc)
    }
    set({ expanded: nextExpanded, selected: rel })
    if (!state.workspaceSlug) return
    for (const dir of toFetch) fetchDir(get, set, state.workspaceSlug, state.gen, state.showIgnored, dir)
  },

  setBaseline: (b) => {
    const state = get()
    if (state.baseline === b) return
    set({ baseline: b })
    void get().refreshStatus()
    if (state.view === 'changes' && state.file && state.workspaceSlug) {
      const relPath = state.file.relPath
      const oldPath = state.status?.byPath[relPath]?.oldPath
      fetchBaseline(get, set, state.workspaceSlug, state.gen, state.fileReq, relPath, oldPath, b, state.revealed)
    }
  },

  setChangedOnly: (v) => {
    set({ changedOnly: v })
  },

  setShowIgnored: (v) => {
    const state = get()
    if (state.showIgnored === v) return
    set({ showIgnored: v })
    if (!state.workspaceSlug) return
    const dirsToRefetch = new Set<string>(['', ...Object.keys(state.expanded)])
    for (const rel of dirsToRefetch) fetchDir(get, set, state.workspaceSlug, state.gen, v, rel)
  },

  refreshStatus: async () => {
    if (statusInFlight) {
      statusTrailingRequested = true
      return
    }
    statusInFlight = true
    try {
      do {
        statusTrailingRequested = false
        const { workspaceSlug, gen, baseline } = get()
        if (!workspaceSlug) break

        set((s) => ({
          status: {
            byPath: s.status?.byPath ?? {},
            dirRollup: s.status?.dirRollup ?? {},
            changes: s.status?.changes ?? [],
            totals: s.status?.totals ?? ZERO_TOTALS,
            truncated: s.status?.truncated ?? false,
            loading: true,
            failed: false,
            at: s.status?.at ?? 0,
          },
        }))

        try {
          const response = await window.cornerOffice.code.getStatus(workspaceSlug, baseline)
          if (get().gen !== gen || get().baseline !== baseline) continue // stale — dropped, per the loop's own trailing check
          if (response.error) {
            set((s) => ({ status: s.status ? { ...s.status, loading: false, failed: true } : s.status }))
          } else {
            set({
              repo: response.data.repo,
              status: {
                byPath: computeByPath(response.data.changes),
                dirRollup: computeDirRollup(response.data.changes),
                changes: response.data.changes,
                totals: response.data.totals,
                truncated: response.data.truncated,
                loading: false,
                failed: false,
                at: Date.now(),
              },
            })
          }
        } catch {
          if (get().gen !== gen || get().baseline !== baseline) continue
          set((s) => ({ status: s.status ? { ...s.status, loading: false, failed: true } : s.status }))
        }
      } while (statusTrailingRequested)
    } finally {
      statusInFlight = false
    }
  },

  loadFileIndex: async () => {
    const { workspaceSlug, gen, showIgnored } = get()
    if (!workspaceSlug) return
    try {
      const response = await window.cornerOffice.code.getFileIndex(workspaceSlug, showIgnored)
      if (get().gen !== gen || get().showIgnored !== showIgnored) return
      if (response.error) return
      set({
        fileIndex: {
          paths: response.data.paths,
          includeIgnored: showIgnored,
          truncated: response.data.truncated,
          at: Date.now(),
        },
      })
    } catch {
      // Quick-open degrades to "no results" on failure; nothing else observes this state.
    }
  },

  handleChanged: (payload) => {
    const state = get()
    if (payload.workspaceSlug !== state.workspaceSlug || payload.gen !== state.gen) return

    if (payload.kind === 'git') {
      if (gitChangeDebounce) clearTimeout(gitChangeDebounce)
      gitChangeDebounce = setTimeout(() => {
        gitChangeDebounce = null
        void get().refreshStatus()
      }, 500)
      return
    }

    if (payload.kind === 'dir') {
      if (!state.workspaceSlug) return
      for (const rel of payload.relPaths) {
        if (!(rel in state.dirs)) continue // only refresh already-loaded dirs
        fetchDir(get, set, state.workspaceSlug, state.gen, state.showIgnored, rel)
      }
      return
    }

    // payload.kind === 'file'
    if (!state.file || !state.workspaceSlug) return
    const relPath = state.file.relPath
    if (!payload.relPaths.includes(relPath)) return // not about the open file
    // Own-write suppression (§3.9.2): a push whose mtime matches what we just
    // wrote is ignored without a refetch, regardless of editing/dirty state.
    if (payload.lastModified !== undefined && payload.lastModified === state.expectedMtime) return
    handleDiskChangeDetected(get, set, state.workspaceSlug, state.gen, state.fileReq, relPath)
  },

  // -------------------------------------------------------------------------
  // Step 2.7 ("B") — file, edit, save and disk-change.
  // -------------------------------------------------------------------------

  openFile: (rel) => {
    const state = get()
    if (!state.workspaceSlug) return
    const { gen, workspaceSlug: slug, view, baseline } = state
    const newFileReq = state.fileReq + 1
    set({
      ...EDIT_RESET,
      revealed: false,
      file: null,
      fileLoading: true,
      fileError: null,
      fileReq: newFileReq,
      baselineDoc: null,
      deletedPath: null,
    })

    void (async () => {
      try {
        const response = await window.cornerOffice.code.readFile(slug, rel, false)
        if (get().gen !== gen || get().fileReq !== newFileReq) return
        if (response.error) {
          const knownChange = get().status?.byPath[rel]
          if (response.error.code === 'NOT_FOUND' && knownChange?.status === 'deleted') {
            // §3.9.1's "Deleted change" row (FR-9): a changed file whose git
            // status is already known to be 'deleted' has no content to
            // read — route to the Changes view (removed content vs.
            // baseline) instead of the generic error surface, since there is
            // no Source or Edit for a file that isn't there. Gated on the
            // known change status (not just NOT_FOUND) so an ordinary
            // missing/mistyped path — no recorded change at all — still
            // surfaces the plain "File not found" error below, per §3.9.3.
            set({ fileLoading: false, deletedPath: rel, view: 'changes' })
            fetchBaseline(get, set, slug, gen, newFileReq, rel, knownChange.oldPath, baseline, false)
            return
          }
          set({ fileLoading: false, fileError: { code: response.error.code, message: friendlyCodeError(response.error) } })
          return
        }
        set({ fileLoading: false, file: response.data })
        if (view === 'changes') {
          const oldPath = get().status?.byPath[rel]?.oldPath
          fetchBaseline(get, set, slug, gen, newFileReq, rel, oldPath, baseline, false)
        }
      } catch (err) {
        if (get().gen !== gen || get().fileReq !== newFileReq) return
        set({ fileLoading: false, fileError: { code: 'INTERNAL_ERROR', message: friendlyCodeError(err) } })
      }
    })()
  },

  reveal: () => {
    const state = get()
    if (!state.workspaceSlug || !state.file) return
    const relPath = state.file.relPath
    const { gen, fileReq, workspaceSlug: slug, view, baseline } = state
    set({ revealed: true })

    void (async () => {
      try {
        const response = await window.cornerOffice.code.readFile(slug, relPath, true)
        if (get().gen !== gen || get().fileReq !== fileReq) return // reveal never applies to another file
        if (response.error) {
          set({ fileError: { code: response.error.code, message: friendlyCodeError(response.error) } })
          return
        }
        set({ file: response.data })
        if (view === 'changes') {
          const oldPath = get().status?.byPath[relPath]?.oldPath
          fetchBaseline(get, set, slug, gen, fileReq, relPath, oldPath, baseline, true)
        }
      } catch (err) {
        if (get().gen !== gen || get().fileReq !== fileReq) return
        set({ fileError: { code: 'INTERNAL_ERROR', message: friendlyCodeError(err) } })
      }
    })()
  },

  setView: (v) => {
    const state = get()
    set({ view: v })
    if (v === 'changes' && state.file && state.workspaceSlug) {
      const relPath = state.file.relPath
      const oldPath = state.status?.byPath[relPath]?.oldPath
      fetchBaseline(get, set, state.workspaceSlug, state.gen, state.fileReq, relPath, oldPath, state.baseline, state.revealed)
    }
  },

  setDiffLayout: (l) => {
    set({ diffLayout: l })
  },

  enterEdit: () => {
    const { file } = get()
    if (!file || file.kind !== 'text' || !file.editable) return
    const doc = textFromContent(file.content)
    set({
      editing: true,
      dirty: false,
      draftDoc: doc,
      baselineText: doc,
      expectedMtime: file.lastModified,
      saving: false,
      saveError: null,
      diskChange: null,
      transientNote: null,
    })
  },

  onDocChange: (doc, dirty) => {
    set((s) => (s.dirty === dirty ? { draftDoc: doc } : { draftDoc: doc, dirty }))
  },

  cancelEdit: () => {
    // Unconditional discard — the caller is responsible for the confirm guard (§3.7.2).
    set({ ...EDIT_RESET })
  },

  save: async () => {
    const state = get()
    if (state.saving) return
    if (!state.editing || !state.workspaceSlug || !state.file || state.file.kind !== 'text' || !state.draftDoc || state.expectedMtime === null) {
      return
    }
    const draft = state.draftDoc
    const eol = state.file.eol === 'crlf' ? '\r\n' : '\n'
    const content = draft.sliceString(0, draft.length, eol)
    const { gen, fileReq, workspaceSlug: slug, expectedMtime } = state
    const relPath = state.file.relPath

    set({ saving: true, saveError: null })
    try {
      const response = await window.cornerOffice.code.writeFile(slug, relPath, content, expectedMtime)
      if (get().gen !== gen || get().fileReq !== fileReq) {
        // The write already happened on disk regardless of whether this is
        // still the open file — still refresh status, just skip the
        // now-irrelevant local state update (§3.6.1 staleness row).
        void get().refreshStatus()
        return
      }
      if (response.error) {
        set({ saving: false })
        if (response.error.code === 'STALE_WRITE') {
          handleDiskChangeDetected(get, set, slug, gen, fileReq, relPath, true)
          return
        }
        set({ saveError: { code: response.error.code, message: friendlyCodeError(response.error) } })
        return
      }
      set((s) => ({
        saving: false,
        editing: false,
        expectedMtime: response.data.lastModified,
        file: s.file && s.file.kind === 'text' ? { ...s.file, content, size: response.data.size, lastModified: response.data.lastModified } : s.file,
      }))
      void get().refreshStatus()
    } catch (err) {
      if (get().gen !== gen || get().fileReq !== fileReq) {
        void get().refreshStatus()
        return
      }
      set({ saving: false, saveError: { code: 'INTERNAL_ERROR', message: friendlyCodeError(err) } })
    }
  },

  reloadFromDisk: () => {
    const state = get()
    if (!state.workspaceSlug || !state.file) return
    const relPath = state.file.relPath
    const { gen, workspaceSlug: slug, revealed } = state
    const newFileReq = state.fileReq + 1
    set({ ...EDIT_RESET, fileReq: newFileReq, fileLoading: true, fileError: null })

    void (async () => {
      try {
        const response = await window.cornerOffice.code.readFile(slug, relPath, revealed)
        if (get().gen !== gen || get().fileReq !== newFileReq) return
        if (response.error) {
          set({ fileLoading: false, fileError: { code: response.error.code, message: friendlyCodeError(response.error) } })
          return
        }
        set({ fileLoading: false, file: response.data })
      } catch (err) {
        if (get().gen !== gen || get().fileReq !== newFileReq) return
        set({ fileLoading: false, fileError: { code: 'INTERNAL_ERROR', message: friendlyCodeError(err) } })
      }
    })()
  },

  keepMine: () => {
    const state = get()
    if (state.diskChange?.kind !== 'modified') {
      // No documented keepMine behavior for the 'deleted' row (Save stays
      // disabled regardless) — just clear the banner defensively.
      set({ diskChange: null })
      return
    }
    // Explicit consent: adopt the new lastModified so the next save isn't
    // rejected as stale, without touching the in-progress draft.
    set({ expectedMtime: state.diskChange.lastModified, diskChange: null })
  },
}))

// Registered with the dirty registry (§3.6.1 rule; §3.7.1) — the registry,
// not this module, decides which sources are in scope for a guard.
registerDirtySource({
  id: 'code-explorer',
  isDirty: () => {
    const s = useCodeExplorerStore.getState()
    return s.editing && s.dirty
  },
  discard: () => useCodeExplorerStore.getState().cancelEdit(),
})
