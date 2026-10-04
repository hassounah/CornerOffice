import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppState } from '../ipc/handlers'
import { denied, notFound } from './safe-fs'
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

/**
 * Resolve a workspace slug to its repo root, enforcing the same M3 rule as
 * `computeRepoRootStatus` server-side. Throws `denied()` / `notFound()`.
 */
export async function resolveRepoRoot(slug: string, appState: AppState): Promise<string> {
  const ws = appState.workspaces.get(slug)
  if (!ws) throw denied()
  let real: string
  try {
    real = await fs.promises.realpath(ws.path)
  } catch {
    throw notFound()
  }
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

  const ws = appState.workspaces.get(slug)
  if (!ws || !SANDBOX_SLUG_RE.test(slug)) throw denied()

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
