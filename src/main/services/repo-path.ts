import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppState } from '../ipc/handlers'
import { IPC_ERROR_CODES } from '../types/ipc'
import type { Availability, Workspace } from '../types/workspace'
import { denied, notFound } from './safe-fs'
import { isNonDefaultProfile } from './app-home'
import { SANDBOX_SLUG_RE, worktreePin } from './sandbox-spec'
import { resolveRealHome, sandboxPaths } from './sandbox-paths'
import type { SandboxPaths } from './sandbox-paths'
import type { RepoTarget } from './git-service'

// ---------------------------------------------------------------------------
// repo-path.ts — root resolution and the relative-path contract for the code
// explorer (TRD §3.3.1, H2, M3).
// ---------------------------------------------------------------------------

// Unicode default-ignorable code points git's is_hfs_dotgit also strips before
// comparing a path segment against ".git" (Sec L-5): zero-width spaces/joiners
// (U+200B..U+200F), bidi embedding/override controls (U+202A..U+202E), word
// joiner and related invisibles (U+2060..U+206F), and the BOM (U+FEFF).
// Expressed as numeric code-point ranges, never as a source-literal escape
// or character, so this file's own source can never smuggle one of the
// characters it strips.
const DEFAULT_IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
]

function stripDefaultIgnorable(segment: string): string {
  let out = ''
  for (const ch of segment) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (DEFAULT_IGNORABLE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)) continue
    out += ch
  }
  return out
}

/**
 * H2: the .git rule, applied to a realpath-relative path. Case-insensitive,
 * with win32 aliases (trailing dot/space, the 8.3 short name) included.
 * `platform` is injectable so both branches are unit-testable on any host.
 */
export function hasGitSegment(relFromRoot: string, platform: NodeJS.Platform = process.platform): boolean {
  return relFromRoot.split(/[\\/]/).some((seg) => {
    let s = stripDefaultIgnorable(seg).toLowerCase()
    if (platform === 'win32') s = s.replace(/[. ]+$/, '') // NTFS trailing dot/space aliasing
    return s === '.git' || (platform === 'win32' && /^git~\d+$/.test(s))
  })
}

/** rel is already zod-validated. CodeQL-recognizable containment guard. */
export function toAbs(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split('/'))
  if (abs !== root && !abs.startsWith(root + path.sep)) throw denied()
  return abs
}

let _realHomedir: string | null = null

/** Cached realpath(os.homedir()). */
export function realHomedir(): string {
  if (_realHomedir === null) _realHomedir = fs.realpathSync(os.homedir())
  return _realHomedir
}

/** M3: never allow $HOME, an ancestor of $HOME, or a filesystem root as repo scope. */
export function isUnsafeRoot(real: string, home: string = realHomedir()): boolean {
  return real === home || home.startsWith(real + path.sep) || real === path.parse(real).root
}

/** The fixed error each non-`ok` availability maps to (Sec H1). Messages are fixed and path-free. */
const UNAVAILABLE: Readonly<Record<Exclude<Availability, 'ok'>, { code: string; message: string }>> = {
  missing: { code: IPC_ERROR_CODES.WORKSPACE_PATH_NOT_FOUND, message: 'Workspace path not found' },
  'not-a-directory': { code: IPC_ERROR_CODES.WORKSPACE_NOT_A_DIRECTORY, message: 'Workspace path is not a directory' },
  unsafe: { code: IPC_ERROR_CODES.WORKSPACE_UNSAFE_ROOT, message: 'Workspace path is not allowed' },
  unreachable: { code: IPC_ERROR_CODES.TIMEOUT, message: 'Request timed out' },
  moved: { code: IPC_ERROR_CODES.NOT_FOUND, message: 'Path not found' },
  checking: { code: IPC_ERROR_CODES.NOT_FOUND, message: 'Path not found' },
  budget: { code: IPC_ERROR_CODES.NOT_FOUND, message: 'Path not found' },
}

/** The fixed error for a workspace whose folder is no longer where it was registered (a symlink swap, a move). */
export function movedError(): Error {
  const { code, message } = UNAVAILABLE.moved
  return Object.assign(new Error(message), { code })
}

/**
 * Fail-closed gate for every consumer of a workspace's path (Sec H1). An unknown id is `denied()`. Otherwise the
 * runtime's synchronous `isAvailable` decides: only an `ok` entry with no probe in flight passes. For anything else
 * a non-blocking, throttled `runtime.recheck()` is fired (so a folder that comes back is noticed) and a fixed error
 * for that state is thrown. Never touches the filesystem and never returns a path for a workspace that is not `ok`.
 */
export function requireAvailableWorkspace(slug: string, appState: AppState): Workspace {
  const ws = appState.workspaces.get(slug)
  if (!ws) throw denied()
  if (appState.runtime.isAvailable(slug)) return ws

  try {
    void Promise.resolve(appState.runtime.recheck()).catch(() => undefined)
  } catch {
    // A recheck that cannot even start must not change the answer: the workspace is unavailable either way.
  }
  // `ok` but not available means a probe is in flight: treat it as still `checking`.
  const state = ws.availability === 'ok' ? 'checking' : ws.availability
  const { code, message } = UNAVAILABLE[state]
  throw Object.assign(new Error(message), { code })
}

/**
 * The non-throwing form of `requireAvailableWorkspace`, for seams that answer "unknown" (the sandbox manager's
 * `getWorkspace`, the channel resolver's `getWorkspacePath`): the workspace while it is available, else undefined.
 * Synchronous, and it does not trigger a recheck.
 */
export function getAvailableWorkspace(slug: string, appState: AppState): Workspace | undefined {
  return appState.runtime.isAvailable(slug) ? appState.workspaces.get(slug) : undefined
}

/**
 * Resolve a workspace slug to its repo root, enforcing the same M3 rule as
 * `computeRepoRootStatus` server-side. The workspace must be available, and its
 * realpath must still equal the registered one (a folder swapped for a symlink
 * after the check is refused). Throws `denied()` / `notFound()` or a fixed
 * availability error.
 */
export async function resolveRepoRoot(slug: string, appState: AppState): Promise<string> {
  const ws = requireAvailableWorkspace(slug, appState)
  let real: string
  try {
    real = await fs.promises.realpath(ws.path)
  } catch {
    throw notFound()
  }
  if (real !== ws.path) throw denied()
  if (!(await fs.promises.stat(real)).isDirectory()) throw notFound()
  if (isUnsafeRoot(real)) throw denied()
  return real
}

/**
 * §3.10: resolves a workspace slug to the tree the Code Explorer should read.
 * `workspace` is exactly `resolveRepoRoot`. `sandbox` is the workspace's
 * sandbox worktree, which an agent can write to while a session runs, so
 * nothing about its structure is trusted: the slug must be well-formed and a
 * known workspace; the realpath must lie under the realpath of
 * SANDBOXES_ROOT and be a directory (no symlinked worktree can point
 * elsewhere); it must not be an unsafe root; and `.git` must be a regular
 * file (the linked-worktree pointer), never a symlink or a directory. The
 * result carries the pin (C2) every git call under the sandboxes root needs.
 * Throws `denied()` / `notFound()`.
 */
export async function resolveCodeRoot(
  slug: string,
  root: 'workspace' | 'sandbox',
  appState: AppState,
  paths: SandboxPaths = sandboxPaths(resolveRealHome()),
): Promise<RepoTarget> {
  if (root === 'workspace') return { root: await resolveRepoRoot(slug, appState) }

  // #0038 D6: the sandboxes root is the real app's, whatever the profile; a profile never reads or watches it.
  if (isNonDefaultProfile()) throw denied()

  if (!SANDBOX_SLUG_RE.test(slug)) throw denied()
  const ws = requireAvailableWorkspace(slug, appState)

  let real: string
  let sandboxesReal: string
  let repoReal: string
  try {
    real = await fs.promises.realpath(path.join(paths.sandboxesRoot, slug))
    sandboxesReal = await fs.promises.realpath(paths.sandboxesRoot)
    repoReal = await fs.promises.realpath(ws.path)
  } catch {
    throw notFound()
  }
  // Exactly <sandboxes root>/<slug>: a symlink to another worktree (sandboxes/a -> sandboxes/b) stays under the
  // root but is not this workspace's tree.
  if (real !== path.join(sandboxesReal, slug)) throw denied()
  if (!(await fs.promises.stat(real)).isDirectory()) throw denied()
  if (isUnsafeRoot(real)) throw denied()

  let gitEntry: fs.Stats
  try {
    gitEntry = await fs.promises.lstat(path.join(real, '.git'))
  } catch {
    throw denied()
  }
  if (!gitEntry.isFile()) throw denied() // a symlink or a directory is never the worktree pointer

  return { root: real, pin: { ...worktreePin(repoReal, slug, paths), workTree: real } }
}

/**
 * The realpath of every existing sandbox worktree, for git-runner's binary
 * check (M4): a `git` that resolves inside any of them is refused. Fresh on
 * every call, never cached.
 */
export function listSandboxWorktreeRoots(paths: SandboxPaths = sandboxPaths(resolveRealHome())): string[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(paths.sandboxesRoot)
  } catch {
    return []
  }
  const roots: string[] = []
  for (const entry of entries) {
    if (!SANDBOX_SLUG_RE.test(entry)) continue
    try {
      roots.push(fs.realpathSync(path.join(paths.sandboxesRoot, entry)))
    } catch {
      // vanished between readdir and realpath
    }
  }
  return roots
}

/**
 * Sync counterpart of the M3 rule for `parseWorkspace`, which cannot await.
 * Drives `Workspace.repoRootStatus` (FR-1's disabled state, §3.5).
 */
export function computeRepoRootStatus(wsPath: string): 'ok' | 'missing' | 'unsafe' {
  let real: string
  try {
    real = fs.realpathSync(wsPath)
  } catch {
    return 'missing'
  }
  let st: fs.Stats
  try {
    st = fs.statSync(real)
  } catch {
    return 'missing'
  }
  if (!st.isDirectory()) return 'missing'
  if (isUnsafeRoot(real)) return 'unsafe'
  return 'ok'
}
