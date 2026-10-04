import fs from 'fs'
import path from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { toAbs, hasGitSegment } from './repo-path'
import type { RepoTarget } from './git-service'
import type { CodeChangedPayload, CodeWatchResponse } from '../types/code'

// ---------------------------------------------------------------------------
// code-watcher.ts — scoped live updates (TRD §3.3.6, H-B1, M8, H-B2, B-L2,
// FR-27; Sec L-8; Be M4).
//
// There is one active watch app-wide, identified by { slug, root, gen } (root
// being 'workspace' or 'sandbox', #0029). `gen` is
// the renderer store's session generation (§3.6.1): it only ever increases,
// across every open/close/slug change, so it is a safe total order for
// deciding whether a `code:watch`/`code:unwatch` call is stale.
//
// This module never talks to git-runner/git-service directly — it takes
// small, purpose-built accessors (resolveRepoRoot, getGitSnapshot, abortRoot)
// so it stays independently testable and doesn't need to know their cache
// shapes. code-handlers.ts (1.18) wires the real services in.
// ---------------------------------------------------------------------------

export const WATCH_DIR_CAP = 256
const REFS_HEADS_DIR_CAP = 64
const FS_DEBOUNCE_MS = 150
const GIT_DEBOUNCE_MS = 300
const EXTERNAL_WATCH_SOURCE = 'code-explorer'

export interface CodeWatcherGitSnapshot {
  gitDir: string | null
  commonDir: string | null
  gitDirValid: boolean
  /** Current branch name (loose-ref fallback only). */
  branch: string | null
  /** repo.base.name when available (loose-ref fallback only). */
  baseBranchName: string | null
}

export interface CodeWatcherDeps {
  /** Resolve a workspace slug and root kind to its realpath'd target. May
   *  throw denied()/notFound() (repo-path.ts) — callers propagate that to
   *  wrapCodeHandler. */
  resolveRoot: (slug: string, root: CodeRootKind) => Promise<RepoTarget>
  /** The git-service cache entry for `root`, if a probe has populated it.
   *  undefined (not yet probed) is treated the same as gitDirValid: false —
   *  git-state paths are simply not added this time. */
  getGitSnapshot: (root: string) => CodeWatcherGitSnapshot | undefined
  /** git-runner's per-root cancellation (§3.3.2) — called when the active
   *  watch moves off a root, so its in-flight git calls are killed too. */
  abortRoot: (root: string) => void
  /** git-service's per-root cache reset, including `unsafe` (Be M4, §D-15).
   *  Called for the new root on every new watch generation (a deliberate
   *  reopen) — never from a poll or any other path, so a driver-race
   *  `git-unsafe` short-circuit can only ever be lifted by reopening the
   *  explorer. */
  resetRoot: (root: string) => void
  fileWatcher: { setExternalWatchCount: (source: string, count: number) => void }
  /** Push a coalesced change to the renderer (code-handlers.ts wraps
   *  webContents.send('code:changed', payload)). */
  onChanged: (payload: CodeChangedPayload) => void
  platform?: NodeJS.Platform
}

export type CodeRootKind = 'workspace' | 'sandbox'

export interface CodeWatchParams {
  workspaceSlug: string
  root: CodeRootKind
  gen: number
  openFile: string | null
  expandedDirs: string[]
}

export interface CodeWatcher {
  watch(params: CodeWatchParams): Promise<CodeWatchResponse>
  unwatch(params: { workspaceSlug: string; root: CodeRootKind; gen: number }): Promise<void>
  /** did-start-navigation / render-process-gone / will-quit (wired in 1.20). */
  closeAll(): Promise<void>
}

interface ActiveWatch {
  slug: string
  /** Which tree is watched. Together with `slug` and `gen` it is the watch's identity. */
  rootKind: CodeRootKind
  gen: number
  root: string
  watcher: FSWatcher
  /** A second, small watcher dedicated to `<commonDir>/refs/heads` at depth
   *  5 — chokidar's `depth` is one setting for the whole instance, and the
   *  primary watcher needs depth 0 for lazily-loaded directories, so the
   *  one case that needs a deeper recursion (the refs/heads git-state
   *  fallback, §3.3.6) gets its own instance instead. Only ever non-null
   *  while that specific fallback is active. */
  refsWatcher: FSWatcher | null
  watchedAbsPaths: Set<string>
  refsWatchedAbsPaths: Set<string>
  limited: boolean
  fsTimer: ReturnType<typeof setTimeout> | null
  gitTimer: ReturnType<typeof setTimeout> | null
  pendingFileRelPaths: Set<string>
  pendingFileLastModified: string | null
  pendingDirRelPaths: Set<string>
}

function totalWatchedDirCount(active: ActiveWatch): number {
  return Object.keys(active.watcher.getWatched()).length + (active.refsWatcher ? Object.keys(active.refsWatcher.getWatched()).length : 0)
}

/** toAbs + realpath + root containment + the .git rule, applied again on the
 *  realpath (H2). Returns the realpath'd absolute path, or null if any check
 *  fails — callers silently drop paths that fail this (unreachable through
 *  the UI, per §3.3.6's "Path containment" note). */
async function validateWatchTarget(
  root: string,
  rel: string,
  platform: NodeJS.Platform,
  opts: { refuseSymlink: boolean },
): Promise<string | null> {
  let abs: string
  try {
    abs = toAbs(root, rel)
  } catch {
    return null
  }
  if (opts.refuseSymlink) {
    try {
      if ((await fs.promises.lstat(abs)).isSymbolicLink()) return null
    } catch {
      return null
    }
  }
  let real: string
  try {
    real = await fs.promises.realpath(abs)
  } catch {
    return null
  }
  if (real !== root && !real.startsWith(root + path.sep)) return null
  if (hasGitSegment(path.relative(root, real), platform)) return null
  return real
}

/** Recursively counts directories under `dir`, stopping as soon as the count
 *  exceeds `cap` (the caller only needs to know "at most cap" vs "more"). */
async function countDirectoriesUnder(dir: string, cap: number): Promise<number> {
  let count = 0
  async function walk(current: string): Promise<void> {
    if (count > cap) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count > cap) return
      if (entry.isDirectory()) {
        count += 1
        await walk(path.join(current, entry.name))
      }
    }
  }
  await walk(dir)
  return count
}

function classifyEvent(
  absPath: string,
  root: string,
  gitRoots: { gitDir: string | null; commonDir: string | null },
  platform: NodeJS.Platform,
): { kind: 'file' | 'dir' | 'git'; relPath: string } | null {
  // Checked FIRST: for a normal (non-external, non-worktree) repo, gitDir
  // and commonDir are root/.git — a subdirectory of root. If the "under
  // root" check below ran first, its own .git-segment guard would drop
  // every git-state event before it ever reached this branch.
  for (const gitRoot of [gitRoots.gitDir, gitRoots.commonDir]) {
    if (gitRoot && (absPath === gitRoot || absPath.startsWith(gitRoot + path.sep))) {
      return { kind: 'git', relPath: '' }
    }
  }
  if (absPath === root || absPath.startsWith(root + path.sep)) {
    const rel = path.relative(root, absPath)
    if (hasGitSegment(rel, platform)) return null // some OTHER .git-like path — never surfaced as file/dir
    return { kind: 'file', relPath: rel } // caller overrides to 'dir' for addDir/unlinkDir
  }
  return null // foreign event — dropped
}

export function createCodeWatcher(deps: CodeWatcherDeps): CodeWatcher {
  const platform = deps.platform ?? process.platform
  let active: ActiveWatch | null = null

  // Serializes every mutation of `active` (watch/unwatch/closeAll) through
  // one queue. Electron does not serialize concurrent ipcMain.handle
  // invocations for the same channel, and watch()/applyWatchSet() have
  // several await points — two overlapping calls could otherwise both
  // observe "no active watch yet" (or a since-superseded one) and race to
  // set `active`, regressing `gen` and leaking the loser's FSWatcher. A
  // single mutex is more robust than re-checking `active`'s identity after
  // every await, which is easy to miss on a future edit.
  let queue: Promise<unknown> = Promise.resolve()
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function scheduleFsFlush(): void {
    if (!active) return
    if (active.fsTimer) clearTimeout(active.fsTimer)
    active.fsTimer = setTimeout(() => flushFs(), FS_DEBOUNCE_MS)
  }

  function flushFs(): void {
    if (!active) return
    active.fsTimer = null
    if (active.pendingFileRelPaths.size > 0) {
      deps.onChanged({
        workspaceSlug: active.slug,
        gen: active.gen,
        kind: 'file',
        relPaths: [...active.pendingFileRelPaths],
        ...(active.pendingFileLastModified ? { lastModified: active.pendingFileLastModified } : {}),
      })
      active.pendingFileRelPaths.clear()
      active.pendingFileLastModified = null
    }
    if (active.pendingDirRelPaths.size > 0) {
      deps.onChanged({ workspaceSlug: active.slug, gen: active.gen, kind: 'dir', relPaths: [...active.pendingDirRelPaths] })
      active.pendingDirRelPaths.clear()
    }
  }

  function scheduleGitFlush(): void {
    if (!active) return
    if (active.gitTimer) clearTimeout(active.gitTimer)
    active.gitTimer = setTimeout(() => {
      if (!active) return
      active.gitTimer = null
      deps.onChanged({ workspaceSlug: active.slug, gen: active.gen, kind: 'git', relPaths: [] })
    }, GIT_DEBOUNCE_MS)
  }

  function handleRawEvent(absPath: string, eventKind: 'file' | 'dir'): void {
    if (!active) return
    const snapshot = deps.getGitSnapshot(active.root)
    const classified = classifyEvent(
      absPath,
      active.root,
      { gitDir: snapshot?.gitDir ?? null, commonDir: snapshot?.commonDir ?? null },
      platform,
    )
    if (!classified) return
    if (classified.kind === 'git') {
      scheduleGitFlush()
      return
    }
    if (eventKind === 'file') {
      active.pendingFileRelPaths.add(classified.relPath)
      fs.promises
        .lstat(absPath)
        .then((st) => {
          if (active) active.pendingFileLastModified = st.mtime.toISOString()
        })
        .catch(() => {
          /* deleted before we could stat it — lastModified stays unset for this flush */
        })
        .finally(() => scheduleFsFlush())
      return
    }
    active.pendingDirRelPaths.add(classified.relPath)
    scheduleFsFlush()
  }

  function wirePrimaryWatcher(watcher: FSWatcher): void {
    watcher
      .on('add', (p: string) => handleRawEvent(p, 'file'))
      .on('change', (p: string) => handleRawEvent(p, 'file'))
      .on('unlink', (p: string) => handleRawEvent(p, 'file'))
      .on('addDir', (p: string) => handleRawEvent(p, 'dir'))
      .on('unlinkDir', (p: string) => handleRawEvent(p, 'dir'))
      .on('error', () => {
        /* a watcher error for one path must not take down the session */
      })
  }

  function wireRefsWatcher(watcher: FSWatcher): void {
    // The refs/heads fallback only ever feeds the 'git' bucket, regardless
    // of file/dir — a new branch ref is still a git-state change, not a
    // worktree file the tree should show.
    watcher
      .on('add', () => scheduleGitFlush())
      .on('change', () => scheduleGitFlush())
      .on('unlink', () => scheduleGitFlush())
      .on('addDir', () => scheduleGitFlush())
      .on('unlinkDir', () => scheduleGitFlush())
      .on('error', () => {
        /* ignore — see wirePrimaryWatcher */
      })
  }

  async function computeGitStatePaths(
    root: string,
  ): Promise<{ fixed: string[]; refsHeadsDir: string | null; refsFallbackPaths: string[]; limited: boolean }> {
    const snapshot = deps.getGitSnapshot(root)
    if (!snapshot || !snapshot.gitDirValid || !snapshot.gitDir || !snapshot.commonDir) {
      return { fixed: [], refsHeadsDir: null, refsFallbackPaths: [], limited: false }
    }
    const fixed = [
      path.join(snapshot.gitDir, 'HEAD'),
      path.join(snapshot.gitDir, 'index'),
      path.join(snapshot.commonDir, 'packed-refs'),
      path.join(snapshot.commonDir, 'config'),
    ]
    const refsHeadsDir = path.join(snapshot.commonDir, 'refs', 'heads')
    const dirCount = await countDirectoriesUnder(refsHeadsDir, REFS_HEADS_DIR_CAP)
    if (dirCount <= REFS_HEADS_DIR_CAP) {
      return { fixed, refsHeadsDir, refsFallbackPaths: [], limited: false }
    }
    const refsFallbackPaths: string[] = []
    if (snapshot.branch) refsFallbackPaths.push(path.join(refsHeadsDir, ...snapshot.branch.split('/')))
    if (snapshot.baseBranchName) refsFallbackPaths.push(path.join(refsHeadsDir, ...snapshot.baseBranchName.split('/')))
    return { fixed, refsHeadsDir: null, refsFallbackPaths, limited: true }
  }

  async function applyWatchSet(w: ActiveWatch, openFile: string | null, expandedDirsRaw: string[]): Promise<CodeWatchResponse> {
    const dirsExceeded = expandedDirsRaw.length > WATCH_DIR_CAP
    const cappedDirs = expandedDirsRaw.slice(0, WATCH_DIR_CAP) // "most recently expanded first" — caller's own ordering

    const validatedDirs: string[] = []
    for (const rel of cappedDirs) {
      const real = await validateWatchTarget(w.root, rel, platform, { refuseSymlink: true })
      if (real) validatedDirs.push(real)
    }

    let validatedFile: string | null = null
    if (openFile !== null) {
      validatedFile = await validateWatchTarget(w.root, openFile, platform, { refuseSymlink: false })
    }

    // These fixed git-state paths (HEAD/index/packed-refs/config, plus the
    // loose-ref fallback) are watched whether or not they currently exist —
    // chokidar picks them up once created (e.g. a loose ref appearing).
    const { fixed, refsHeadsDir, refsFallbackPaths, limited: refsLimited } = await computeGitStatePaths(w.root)

    const newTargets = new Set<string>(validatedDirs)
    if (validatedFile) newTargets.add(validatedFile)
    for (const p of [...fixed, ...refsFallbackPaths]) newTargets.add(p)

    const toAdd = [...newTargets].filter((p) => !w.watchedAbsPaths.has(p))
    const toRemove = [...w.watchedAbsPaths].filter((p) => !newTargets.has(p))
    if (toRemove.length > 0) w.watcher.unwatch(toRemove)
    if (toAdd.length > 0) w.watcher.add(toAdd)
    w.watchedAbsPaths = newTargets

    // The refs/heads depth-5 fallback watcher (see ActiveWatch.refsWatcher).
    if (refsHeadsDir && !w.refsWatchedAbsPaths.has(refsHeadsDir)) {
      w.refsWatcher?.close().catch(() => {})
      const refsWatcher = chokidar.watch([], {
        ignoreInitial: true,
        followSymlinks: false,
        depth: 5,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      })
      wireRefsWatcher(refsWatcher)
      refsWatcher.add(refsHeadsDir)
      w.refsWatcher = refsWatcher
      w.refsWatchedAbsPaths = new Set([refsHeadsDir])
    } else if (!refsHeadsDir && w.refsWatcher) {
      w.refsWatcher.close().catch(() => {})
      w.refsWatcher = null
      w.refsWatchedAbsPaths = new Set()
    }

    w.limited = dirsExceeded || refsLimited

    deps.fileWatcher.setExternalWatchCount(EXTERNAL_WATCH_SOURCE, totalWatchedDirCount(w))

    return { watching: totalWatchedDirCount(w), limited: w.limited }
  }

  async function doWatch(params: CodeWatchParams): Promise<CodeWatchResponse> {
    const { workspaceSlug, root: rootKind, gen, openFile, expandedDirs } = params

    if (active && gen < active.gen) {
      return { watching: totalWatchedDirCount(active), limited: active.limited }
    }

    if (active && active.slug === workspaceSlug && active.rootKind === rootKind && active.gen === gen) {
      return applyWatchSet(active, openFile, expandedDirs)
    }

    // A higher gen, or the same/higher gen but a different slug or root: replace.
    const previousRoot = active?.root ?? null
    if (active) {
      const stale = active
      stale.watcher.close().catch(() => {})
      stale.refsWatcher?.close().catch(() => {})
      if (stale.fsTimer) clearTimeout(stale.fsTimer)
      if (stale.gitTimer) clearTimeout(stale.gitTimer)
      active = null
    }

    const { root } = await deps.resolveRoot(workspaceSlug, rootKind) // may throw denied()/notFound()
    if (previousRoot) deps.abortRoot(previousRoot)
    // A new watch generation is exactly "a deliberate reopen" (§D-15) — the
    // one place a prior git-unsafe short-circuit for this root is lifted.
    deps.resetRoot(root)

    const watcher = chokidar.watch([], {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (p: string) => hasGitSegment(path.basename(p), platform),
    })
    wirePrimaryWatcher(watcher)

    active = {
      slug: workspaceSlug,
      rootKind,
      gen,
      root,
      watcher,
      refsWatcher: null,
      watchedAbsPaths: new Set(),
      refsWatchedAbsPaths: new Set(),
      limited: false,
      fsTimer: null,
      gitTimer: null,
      pendingFileRelPaths: new Set(),
      pendingFileLastModified: null,
      pendingDirRelPaths: new Set(),
    }
    return applyWatchSet(active, openFile, expandedDirs)
  }

  function teardown(w: ActiveWatch): void {
    if (w.fsTimer) clearTimeout(w.fsTimer)
    if (w.gitTimer) clearTimeout(w.gitTimer)
    w.watcher.close().catch(() => {})
    w.refsWatcher?.close().catch(() => {})
    deps.abortRoot(w.root)
    deps.fileWatcher.setExternalWatchCount(EXTERNAL_WATCH_SOURCE, 0)
  }

  function doUnwatch(params: { workspaceSlug: string; root: CodeRootKind; gen: number }): void {
    if (!active) return
    if (active.slug !== params.workspaceSlug || active.rootKind !== params.root || active.gen !== params.gen) return // stale — no-op (§3.3.6)
    teardown(active)
    active = null
  }

  function doCloseAll(): void {
    if (!active) return
    teardown(active)
    active = null
  }

  function watch(params: CodeWatchParams): Promise<CodeWatchResponse> {
    return enqueue(() => doWatch(params))
  }

  function unwatch(params: { workspaceSlug: string; root: CodeRootKind; gen: number }): Promise<void> {
    return enqueue(() => Promise.resolve(doUnwatch(params)))
  }

  function closeAll(): Promise<void> {
    return enqueue(() => Promise.resolve(doCloseAll()))
  }

  return { watch, unwatch, closeAll }
}
