import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import type { StateCache } from '../types'
import { hasNameUnsafeChar, hasPathUnsafeChar } from '../types/slugs'
import { isInsideAppFolder, isRefusedAsWorkspace } from './anchored-paths'
import { DeadlineError, withDeadline } from './fs-deadline'
import { PassThroughError, type JsonStore } from './json-store'
import { isUnsafeRoot } from './repo-path'
import { resolveRealHome, sandboxPaths } from './sandbox-paths'
import { readGitFileGitDir } from './sandbox-worktree'
import { AbsPath, REGISTRY_MAX } from './stores'
import type { Registry, RegistryEntry, SandboxFile, SessionDefaultsFile, Settings } from './stores'

// ---------------------------------------------------------------------------
// workspace-registry.ts — the workspace registry (#0039, TRD §3.5).
//
// Step 2.1 added the contract (types, errors). Step 2.2 added ids and the event resolver. This
// step adds the operations: `createWorkspaceRegistry(deps)`.
//
// Accepted race (BE L-4): `remove` checks that no session is live, then writes the registry. A
// session started between the check and the write is not blocked, but it fails at its next
// registry lookup, because the workspace is gone by then. The window is a few milliseconds and
// the failure is a clean "not found", so no cross-module lock is taken.
//
// Store order (X2(3)), documented once, here. Every registry operation runs on ONE serialized
// `registryOps` queue. While holding it, the registry calls `sandboxStore`, `registryStore`,
// `sessionDefaultsStore`, `settingsStore` and `stateCacheService`, in that order. No store's
// `mutate` function ever calls another store, and no other module ever enters `registryOps`,
// so no lock cycle is possible.
//
// No filesystem access happens at import time.
// ---------------------------------------------------------------------------

export type { RegistryEntry } from './stores'
export type { Availability } from '../types/workspace'

/** Why a path was refused or skipped. `TIMEOUT` is a filesystem call that hit its deadline. */
export type SkipCode =
  | 'WORKSPACE_PATH_NOT_FOUND'
  | 'WORKSPACE_NOT_A_DIRECTORY'
  | 'WORKSPACE_UNSAFE_ROOT'
  | 'WORKSPACE_APP_FOLDER'
  | 'WORKSPACE_DUPLICATE'
  | 'WORKSPACE_LIMIT'
  | 'TIMEOUT'

/** Why `workspace:listChanged` fired. */
export type ListChangedReason = 'added' | 'removed' | 'updated' | 'recheck'

/** Non-fatal outcomes of creating a workspace. A fixed token union: there is never stderr (TRD §3.7). */
export type CreateWarning = 'git-unavailable' | 'git-init-failed' | 'git-commit-failed'

/** Who an activity event belongs to: a registered workspace, or no one (`key` is the plugin's event key). */
export type EventOwner = { kind: 'id'; id: string } | { kind: 'unattributed'; key: string }

/** Everything a registry operation can refuse with. Each maps to one IPC code and one renderer copy string. */
export type WorkspaceErrorCode =
  | Exclude<SkipCode, 'TIMEOUT'>
  | 'WORKSPACE_EXISTS'
  | 'WORKSPACE_NAME_INVALID'
  | 'WORKSPACE_BUSY_TERMINAL'
  | 'WORKSPACE_BUSY_SANDBOX'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'NOT_READY'
  | 'TIMEOUT'

/** Neutral English, no paths and no names (Sec M1). The renderer owns the user-facing copy. */
const FIXED_MESSAGES: Readonly<Record<WorkspaceErrorCode, string>> = {
  WORKSPACE_PATH_NOT_FOUND: 'Workspace path not found',
  WORKSPACE_NOT_A_DIRECTORY: 'Workspace path is not a directory',
  WORKSPACE_UNSAFE_ROOT: 'Workspace path is not allowed',
  WORKSPACE_APP_FOLDER: 'Workspace path overlaps application data',
  WORKSPACE_DUPLICATE: 'Workspace already added',
  WORKSPACE_LIMIT: 'Workspace limit reached',
  WORKSPACE_EXISTS: 'Workspace folder already exists',
  WORKSPACE_NAME_INVALID: 'Workspace name is not valid',
  WORKSPACE_BUSY_TERMINAL: 'Workspace has a running session',
  WORKSPACE_BUSY_SANDBOX: 'Workspace sandbox is busy',
  VALIDATION_ERROR: 'Invalid request',
  NOT_FOUND: 'Workspace not found',
  NOT_READY: 'Not ready',
  TIMEOUT: 'Timed out',
}

/**
 * A refusal from a registry operation. It extends `PassThroughError`, so it crosses a
 * `JsonStore.mutate` callback unchanged instead of being wrapped as `CONFIG_WRITE_FAILED`.
 * The message is fixed per code: it never carries a path or a name.
 */
export class WorkspaceError extends PassThroughError {
  readonly code: WorkspaceErrorCode

  constructor(code: WorkspaceErrorCode) {
    super(FIXED_MESSAGES[code])
    this.name = 'WorkspaceError'
    this.code = code
  }
}

export interface SkippedPath {
  path: string
  code: SkipCode
}

export interface AddManyResult {
  added: RegistryEntry[]
  skipped: SkippedPath[]
}

export interface WorkspaceRegistry {
  list(): readonly RegistryEntry[]
  add(rawPath: string, source: 'manual' | 'discovered'): Promise<RegistryEntry>
  addMany(rawPaths: readonly string[]): Promise<AddManyResult>
  /**
   * Register a folder Corner Office just created (`workspace-create`, BE H-1). `real` is its realpath,
   * already validated by the caller; the entry is `source: 'manual'`. `displayName` is set when the
   * allocated id differs from the name the user typed (UX H5), else null.
   */
  addCreated(real: string, opts: { displayName: string | null }): Promise<RegistryEntry>
  remove(id: string): Promise<void>
  setHidden(id: string, hidden: boolean): Promise<RegistryEntry>
  rename(id: string, displayName: string | null): Promise<RegistryEntry>
  setDocsRoot(id: string, docsRoot: string | null): Promise<RegistryEntry>
  /** Startup (X2(4)): prune registry-keyed state left behind by a failed prune. */
  reconcile(): Promise<void>
}

// ---------------------------------------------------------------------------
// Ids (X2(1))
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 64
const ID_ATTEMPTS_MAX = 10_000
const FS_DEADLINE_MS = 2000

/** The plugin's `_get_workspace_slug` (emit_activity.py:27-33), byte for byte: the `events/<key>/` directory name. */
export function eventKeyFor(p: string): string {
  const name = path.basename(p.replace(/\/+$/, ''))
  return name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, ID_MAX_LENGTH) || 'unknown'
}

/** The id a folder would like: its event key without leading non-alphanumerics; `workspace` when nothing is left. */
export function idBase(selectedPath: string): string {
  const b = eventKeyFor(selectedPath).replace(/^[^a-zA-Z0-9]+/, '')
  return b === '' || b === 'unknown' ? 'workspace' : b
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

type Probe = 'absent' | { stat: fs.Stats }

/** lstat with a deadline. ENOENT is `absent`; every other failure (including the deadline) throws. */
async function probe(p: string): Promise<Probe> {
  try {
    return { stat: await withDeadline(fs.promises.lstat(p), FS_DEADLINE_MS) }
  } catch (err) {
    if (isEnoent(err)) return 'absent'
    throw err
  }
}

/**
 * Fail-closed taken-check (Sec M4, L9). The id is free ONLY when
 *  - neither `<sandboxesRoot>/<id>` nor `<sandboxStateRoot>/<id>` exists; or
 *  - the sandbox worktree there belongs to THIS repo (its `.git` pointer and `<real>/.git/worktrees/<id>`
 *    both resolve to the same directory) and any state dir is a plain directory.
 * Every other outcome counts as taken: an empty dir, garbage or a directory where the `.git` file
 * should be, a missing `worktrees/<id>`, a throw, a deadline, a state dir with no worktree.
 */
async function isSandboxTaken(id: string, real: string): Promise<boolean> {
  try {
    const { sandboxesRoot, sandboxStateRoot } = sandboxPaths(resolveRealHome())
    const wt = path.join(sandboxesRoot, id)
    const stateDir = path.join(sandboxStateRoot, id)
    const [wtProbe, stateProbe] = await Promise.all([probe(wt), probe(stateDir)])

    if (wtProbe === 'absent') return stateProbe !== 'absent'
    if (stateProbe !== 'absent' && (stateProbe.stat.isSymbolicLink() || !stateProbe.stat.isDirectory())) return true

    const pointer = await withDeadline(readGitFileGitDir(wt), FS_DEADLINE_MS)
    if (pointer === null) return true
    const [pointed, expected] = await Promise.all([
      withDeadline(fs.promises.realpath(pointer), FS_DEADLINE_MS),
      withDeadline(fs.promises.realpath(path.join(real, '.git', 'worktrees', id)), FS_DEADLINE_MS),
    ])
    return pointed !== expected
  } catch {
    return true
  }
}

/**
 * Allocate a registry id for a folder: `idBase`, then `base-2`, `base-3` ... (the suffix is kept within
 * 64 characters), returning the first id that is not taken. Taken means: already registered
 * (case-insensitive), or claimed by a sandbox worktree or state dir that is not provably this repo's.
 * `registered` is every id already in the registry, including ones added earlier in the same operation.
 */
export async function allocateId(selectedPath: string, real: string, registered: readonly string[]): Promise<string> {
  const base = idBase(selectedPath)
  const taken = new Set(registered.map((id) => id.toLowerCase()))
  for (let n = 1; n <= ID_ATTEMPTS_MAX; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const id = `${base.slice(0, ID_MAX_LENGTH - suffix.length)}${suffix}`
    if (taken.has(id.toLowerCase())) continue
    if (!(await isSandboxTaken(id, real))) return id
  }
  throw new WorkspaceError('WORKSPACE_LIMIT')
}

// ---------------------------------------------------------------------------
// Event attribution (C1 fix; the plugin contract is unchanged)
// ---------------------------------------------------------------------------

/** Registered workspaces by the event key the plugin derives from their `selectedPath` (X3). Rebuild on every registry change. */
export function buildEventIndex(entries: readonly RegistryEntry[]): ReadonlyMap<string, readonly RegistryEntry[]> {
  const index = new Map<string, RegistryEntry[]>()
  for (const entry of entries) {
    const key = eventKeyFor(entry.selectedPath)
    const list = index.get(key)
    if (list) list.push(entry)
    else index.set(key, [entry])
  }
  return index
}

/**
 * Who owns an event written under `events/<eventKey>/`. `cwd` only ever selects inside the candidate set
 * derived from the directory name (SEC-H2), and never guesses:
 *  - no candidate for the key → unattributed;
 *  - a `cwd` (must be absolute; `..` segments are resolved first) → the deepest candidate containing it,
 *    else unattributed (a foreign cwd);
 *  - no `cwd` → the candidate when there is exactly one, else unattributed.
 */
export function resolveEventWorkspace(
  index: ReadonlyMap<string, readonly RegistryEntry[]>,
  eventKey: string,
  cwd: string | undefined,
): EventOwner {
  const unattributed: EventOwner = { kind: 'unattributed', key: eventKey }
  const candidates = index.get(eventKey) ?? []
  if (candidates.length === 0) return unattributed
  if (cwd !== undefined) {
    if (!path.isAbsolute(cwd)) return unattributed // Sec L3
    const c = path.resolve(cwd)
    const inside = (root: string) => c === root || c.startsWith(root + path.sep)
    const hit = candidates.filter((e) => inside(e.selectedPath) || inside(e.path)).sort((a, b) => b.path.length - a.path.length)[0]
    return hit ? { kind: 'id', id: hit.id } : unattributed
  }
  return candidates.length === 1 ? { kind: 'id', id: candidates[0].id } : unattributed
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

const PATH_MAX = 4096
const NAME_MAX = 200

export interface ValidatedPath {
  /** `path.resolve(raw)`: as chosen, normalized, not realpath'd. Event matching only (X3). */
  selected: string
  /** `realpath(selected)`: every trust decision uses this. */
  real: string
}

export interface ValidatePathOptions {
  /**
   * Container mode, for a folder that only HOLDS a new workspace: `$HOME`, its ancestors and `/` are accepted, and the
   * app folders are refused only when the path is at or inside one (an ancestor of them is fine).
   */
  allowUnsafeRoot?: boolean
}

/** Await an fs call under the 2 s deadline; the deadline becomes a `TIMEOUT` refusal. */
export async function bounded<T>(p: Promise<T>): Promise<T> {
  try {
    return await withDeadline(p, FS_DEADLINE_MS)
  } catch (err) {
    if (err instanceof DeadlineError) throw new WorkspaceError('TIMEOUT')
    throw err
  }
}

/**
 * Steps 1-5 of `validateCandidate` (TRD §3.5), each fs call under `withDeadline(2000)`:
 *  1. a valid `AbsPathInput` (absolute, <= 4096, no control characters), else `VALIDATION_ERROR`;
 *  2. `realpath` (ENOENT and friends -> `WORKSPACE_PATH_NOT_FOUND`);
 *  3. a directory, else `WORKSPACE_NOT_A_DIRECTORY`;
 *  4. not `$HOME`, an ancestor of it, or `/` -> `WORKSPACE_UNSAFE_ROOT`;
 *  5. not the app's own folders (`isRefusedAsWorkspace`: `isAppFolder` plus the sandbox-worktree carve-out)
 *     -> `WORKSPACE_APP_FOLDER`.
 * Every failure is a `WorkspaceError`; nothing else escapes. `.rix` is not required.
 */
export async function validatePath(raw: unknown, options: ValidatePathOptions = {}): Promise<ValidatedPath> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PATH_MAX || !path.isAbsolute(raw) || hasPathUnsafeChar(raw)) {
    throw new WorkspaceError('VALIDATION_ERROR')
  }
  const selected = path.resolve(raw)

  let real: string
  try {
    real = await bounded(fs.promises.realpath(selected))
  } catch (err) {
    if (err instanceof WorkspaceError) throw err
    throw new WorkspaceError('WORKSPACE_PATH_NOT_FOUND')
  }
  // A symlink target can carry characters a registry entry must never hold.
  if (real.length > PATH_MAX || hasPathUnsafeChar(real)) throw new WorkspaceError('VALIDATION_ERROR')

  let isDirectory: boolean
  try {
    isDirectory = (await bounded(fs.promises.stat(real))).isDirectory()
  } catch (err) {
    if (err instanceof WorkspaceError) throw err
    throw new WorkspaceError('WORKSPACE_PATH_NOT_FOUND')
  }
  if (!isDirectory) throw new WorkspaceError('WORKSPACE_NOT_A_DIRECTORY')

  let home: string
  try {
    home = resolveRealHome()
  } catch {
    throw new WorkspaceError('WORKSPACE_UNSAFE_ROOT') // cannot tell what is safe: fail closed
  }
  if (options.allowUnsafeRoot) {
    // Container mode ("Create new" parent): `$HOME`, its ancestors and `/` may hold a new folder, which is then
    // validated in full. Only a folder AT or INSIDE the app's own folders is refused.
    if (isInsideAppFolder(real, home)) throw new WorkspaceError('WORKSPACE_APP_FOLDER')
  } else {
    if (isUnsafeRoot(real, home)) throw new WorkspaceError('WORKSPACE_UNSAFE_ROOT')
    if (isRefusedAsWorkspace(real, home)) throw new WorkspaceError('WORKSPACE_APP_FOLDER')
  }
  return { selected, real }
}

// ---------------------------------------------------------------------------
// State pruning (the `state.json` per-id maps)
// ---------------------------------------------------------------------------

/** The `state.json` maps keyed by workspace id. */
const STATE_ID_MAPS = ['workspaceLevels', 'historyChecksums', 'lastKnownHistoryEntries', 'unacknowledgedAttentionEvents'] as const

/** Removes workspace ids from `state.json`'s per-id maps. */
export interface StatePruner {
  removeId(id: string): void
  /** Drop every key that is not in `ids`. Returns true when something changed. */
  reconcile(ids: ReadonlySet<string>): boolean
}

export interface StateCacheLike {
  getCache(): StateCache
  updateField<K extends keyof StateCache>(key: K, value: StateCache[K]): void
}

export function createStatePruner(service: StateCacheLike): StatePruner {
  function prune(keep: (id: string) => boolean): boolean {
    let changed = false
    const cache = service.getCache()
    for (const field of STATE_ID_MAPS) {
      const map = cache[field] as Record<string, unknown>
      const kept = Object.fromEntries(Object.entries(map).filter(([id]) => keep(id)))
      if (Object.keys(kept).length !== Object.keys(map).length) {
        service.updateField(field, kept as never)
        changed = true
      }
    }
    return changed
  }
  return {
    removeId: (id) => {
      prune((key) => key !== id)
    },
    reconcile: (ids) => prune((key) => ids.has(key)),
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface TerminalProbe {
  hasSession(id: string): boolean
}

export interface SandboxProbe {
  /** True while the workspace's sandbox is starting, running, stopping, or has a live session. */
  isBusy(id: string): boolean
}

export interface RegistryDeps {
  registryStore: JsonStore<Registry>
  sandboxStore: JsonStore<SandboxFile>
  sessionDefaultsStore: JsonStore<SessionDefaultsFile>
  settingsStore: JsonStore<Settings>
  statePruner: StatePruner
  /** Lazy: the managers are built after the registry. A null return means "not built yet" -> `NOT_READY` (Sec L7). */
  getTerminalManager: () => TerminalProbe | null
  getSandboxManager: () => SandboxProbe | null
  now?: () => Date
}

/** Registry health states `reconcile` may act on. Corruption must never cascade into deleting sandbox allowlists. */
const RECONCILE_HEALTH: readonly string[] = ['ok', 'absent', 'recovered-from-backup']

const SKIP_CODES: readonly SkipCode[] = [
  'WORKSPACE_PATH_NOT_FOUND',
  'WORKSPACE_NOT_A_DIRECTORY',
  'WORKSPACE_UNSAFE_ROOT',
  'WORKSPACE_APP_FOLDER',
  'WORKSPACE_DUPLICATE',
  'WORKSPACE_LIMIT',
  'TIMEOUT',
]

/** How many `addMany` paths are validated at once. */
const ADD_MANY_CONCURRENCY = 4

/** `fn` over `items` with at most `limit` in flight; results keep the input order. `fn` must not reject. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function toSkipCode(err: unknown): SkipCode {
  const code = err instanceof WorkspaceError ? err.code : undefined
  return SKIP_CODES.find((c) => c === code) ?? 'WORKSPACE_PATH_NOT_FOUND'
}

export function createWorkspaceRegistry(deps: RegistryDeps): WorkspaceRegistry {
  const { registryStore, sandboxStore, sessionDefaultsStore, settingsStore, statePruner } = deps
  const now = deps.now ?? (() => new Date())

  // Every operation runs here, one at a time. The queue is the registry's lock.
  let registryOps: Promise<unknown> = Promise.resolve()
  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = registryOps.then(op)
    registryOps = run.catch(() => undefined)
    return run
  }

  const find = (id: string): RegistryEntry => {
    const entry = registryStore.get().workspaces.find((w) => w.id === id)
    if (!entry) throw new WorkspaceError('NOT_FOUND')
    return entry
  }

  /** Best-effort: a failure is logged, never thrown. `reconcile` cleans up on the next launch. */
  async function bestEffort(what: string, op: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await op()
    } catch (err) {
      log.warn(`[Registry] could not prune ${what}`, err instanceof Error ? err.name : 'error')
    }
  }

  /** Drop `ids` from session defaults, the realm mapping and state.json. Writes only where something is present. */
  async function pruneRegistryKeyedState(ids: readonly string[]): Promise<void> {
    const drop = new Set(ids)
    await bestEffort('session defaults', async () => {
      const current = sessionDefaultsStore.get().workspaces
      if (!ids.some((id) => Object.hasOwn(current, id))) return
      await sessionDefaultsStore.mutate((s) => ({ ...s, workspaces: Object.fromEntries(Object.entries(s.workspaces).filter(([id]) => !drop.has(id))) }))
    })
    await bestEffort('realm mapping', async () => {
      if (!settingsStore.get().realm.mapping.some((m) => m.workspaceSlug !== null && drop.has(m.workspaceSlug))) return
      await settingsStore.mutate((s) => ({
        ...s,
        realm: { ...s.realm, mapping: s.realm.mapping.map((m) => (m.workspaceSlug !== null && drop.has(m.workspaceSlug) ? { ...m, workspaceSlug: null } : m)) },
      }))
    })
    await bestEffort('state cache', () => {
      for (const id of ids) statePruner.removeId(id)
    })
  }

  /** Delete `ids` from `sandbox.json`. Throws on a write failure; resolves without a write when none is present. */
  async function pruneSandbox(ids: readonly string[]): Promise<void> {
    const current = sandboxStore.get().workspaces
    const present = ids.filter((id) => Object.hasOwn(current, id))
    if (present.length === 0) return
    const drop = new Set(present)
    await sandboxStore.mutate((s) => ({ ...s, workspaces: Object.fromEntries(Object.entries(s.workspaces).filter(([id]) => !drop.has(id))) }))
  }

  function makeEntry(id: string, v: ValidatedPath, source: 'manual' | 'discovered', displayName: string | null): RegistryEntry {
    return { id, path: v.real, selectedPath: v.selected, displayName, docsRoot: null, hidden: false, source, addedAt: now().toISOString() }
  }

  async function addOne(rawPath: string, source: 'manual' | 'discovered', displayName: string | null): Promise<RegistryEntry> {
    const validated = await validatePath(rawPath)
    const current = registryStore.get().workspaces
    if (current.some((w) => w.path === validated.real)) throw new WorkspaceError('WORKSPACE_DUPLICATE')
    if (current.length >= REGISTRY_MAX) throw new WorkspaceError('WORKSPACE_LIMIT')

    const id = await allocateId(validated.selected, validated.real, current.map((w) => w.id))
    // A reused id must never inherit an old folder's network allowlist: this write has to land first.
    await pruneSandbox([id])

    const entry = makeEntry(id, validated, source, displayName)
    await registryStore.mutate((r) => {
      if (r.workspaces.some((w) => w.path === entry.path)) throw new WorkspaceError('WORKSPACE_DUPLICATE')
      if (r.workspaces.length >= REGISTRY_MAX) throw new WorkspaceError('WORKSPACE_LIMIT')
      return { ...r, workspaces: [...r.workspaces, entry] }
    })
    await pruneRegistryKeyedState([id])
    return entry
  }

  function validateDisplayName(displayName: string | null): string | null {
    if (displayName === null) return null
    const trimmed = typeof displayName === 'string' ? displayName.trim() : ''
    if (trimmed.length === 0 || trimmed.length > NAME_MAX || hasNameUnsafeChar(trimmed)) throw new WorkspaceError('VALIDATION_ERROR')
    return trimmed
  }

  async function replaceEntry(id: string, change: (e: RegistryEntry) => RegistryEntry): Promise<RegistryEntry> {
    find(id)
    let updated: RegistryEntry | undefined
    await registryStore.mutate((r) => ({
      ...r,
      workspaces: r.workspaces.map((w) => {
        if (w.id !== id) return w
        updated = change(w)
        return updated
      }),
    }))
    if (!updated) throw new WorkspaceError('NOT_FOUND')
    return updated
  }

  return {
    list: () => registryStore.get().workspaces,

    add: (rawPath, source) => enqueue(() => addOne(rawPath, source, null)),

    addCreated: (real, opts) => enqueue(() => addOne(real, 'manual', validateDisplayName(opts.displayName))),

    addMany: async (rawPaths) => {
      // Validation is read-only filesystem work, so it runs a few paths at a time OUTSIDE the registry queue (a slow
      // mount no longer holds every other registry operation). Duplicates and the cap are decided inside the queue.
      const validations = await mapWithLimit(rawPaths, ADD_MANY_CONCURRENCY, (raw) =>
        validatePath(raw).then(
          (validated) => ({ validated }),
          (error: unknown) => ({ error }),
        ),
      )
      return enqueue(async () => {
        const existing = registryStore.get().workspaces
        const ids = existing.map((w) => w.id)
        const paths = new Set(existing.map((w) => w.path))
        const pending: RegistryEntry[] = []
        const skipped: SkippedPath[] = []

        for (const [index, raw] of rawPaths.entries()) {
          try {
            if (existing.length + pending.length >= REGISTRY_MAX) throw new WorkspaceError('WORKSPACE_LIMIT')
            const outcome = validations[index]
            if ('error' in outcome) throw outcome.error
            const validated = outcome.validated
            if (paths.has(validated.real)) throw new WorkspaceError('WORKSPACE_DUPLICATE')
            const id = await allocateId(validated.selected, validated.real, ids)
            ids.push(id)
            paths.add(validated.real)
            pending.push(makeEntry(id, validated, 'discovered', null))
          } catch (err) {
            skipped.push({ path: raw, code: toSkipCode(err) })
          }
        }
        if (pending.length === 0) return { added: [], skipped }

        await pruneSandbox(pending.map((e) => e.id)) // one write, only when needed; failing it fails the batch
        await registryStore.mutate((r) => ({ ...r, workspaces: [...r.workspaces, ...pending] })) // one write, one push
        await pruneRegistryKeyedState(pending.map((e) => e.id))
        return { added: pending, skipped }
      })
    },

    remove: (id) =>
      enqueue(async () => {
        find(id)
        const terminal = deps.getTerminalManager()
        const sandbox = deps.getSandboxManager()
        if (!terminal || !sandbox) throw new WorkspaceError('NOT_READY')
        if (terminal.hasSession(id)) throw new WorkspaceError('WORKSPACE_BUSY_TERMINAL')
        if (sandbox.isBusy(id)) throw new WorkspaceError('WORKSPACE_BUSY_SANDBOX')

        await registryStore.mutate((r) => ({ ...r, workspaces: r.workspaces.filter((w) => w.id !== id) }))
        await bestEffort('sandbox allowlist', () => pruneSandbox([id]))
        await pruneRegistryKeyedState([id])
        // No files are touched: a sandbox worktree, if one exists, stays on disk.
      }),

    setHidden: (id, hidden) => enqueue(() => replaceEntry(id, (e) => ({ ...e, hidden }))),

    rename: (id, displayName) => {
      return enqueue(() => {
        const name = validateDisplayName(displayName)
        return replaceEntry(id, (e) => ({ ...e, displayName: name }))
      })
    },

    setDocsRoot: (id, docsRoot) =>
      enqueue(async () => {
        find(id)
        if (docsRoot !== null) {
          if (!AbsPath.safeParse(docsRoot).success) throw new WorkspaceError('VALIDATION_ERROR')
          // The folder may not exist (it then shows the not-available state), so a missing path is judged as given.
          let real = docsRoot
          try {
            real = await bounded(fs.promises.realpath(docsRoot))
          } catch (err) {
            if (err instanceof WorkspaceError) throw err
          }
          const home = resolveRealHome()
          if (isUnsafeRoot(real, home)) throw new WorkspaceError('WORKSPACE_UNSAFE_ROOT')
          if (isRefusedAsWorkspace(real, home)) throw new WorkspaceError('WORKSPACE_APP_FOLDER')
        }
        return replaceEntry(id, (e) => ({ ...e, docsRoot }))
      }),

    reconcile: () =>
      enqueue(async () => {
        if (!RECONCILE_HEALTH.includes(registryStore.health())) {
          log.warn('[Registry] reconcile skipped: the registry file was not read cleanly')
          return
        }
        const ids = new Set(registryStore.get().workspaces.map((w) => w.id))
        const stale = (keys: Iterable<string>) => [...keys].filter((k) => !ids.has(k))

        await bestEffort('sandbox allowlists', () => pruneSandbox(stale(Object.keys(sandboxStore.get().workspaces))))
        await pruneRegistryKeyedState(
          stale([...Object.keys(sessionDefaultsStore.get().workspaces), ...settingsStore.get().realm.mapping.flatMap((m) => (m.workspaceSlug === null ? [] : [m.workspaceSlug]))]),
        )
        await bestEffort('state cache', () => statePruner.reconcile(ids))
      }),
  }
}
