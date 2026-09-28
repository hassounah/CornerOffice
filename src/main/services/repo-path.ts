import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppState } from '../ipc/handlers'
import { denied, notFound } from './safe-fs'

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
