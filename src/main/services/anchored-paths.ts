import fs from 'fs'
import path from 'path'
import { claudeHome, coHome, configDir, defaultConfigDir, isInSandbox } from './app-home'
import { hiddenHomeSegments, realDataRoot, resolveRealHome, sandboxPaths } from './sandbox-paths'
import { SANDBOX_SLUG_RE } from '../types/slugs'

// ---------------------------------------------------------------------------
// anchored-paths.ts — which host paths belong to Corner Office and Claude Code
// themselves, so a workspace, a docs root or a discovery hit never is, sits
// inside, or contains one (#0039, TRD §3.5, Sec M2).
//
// Anchors are computed lazily on every call (the profile is known only after
// `setActiveProfile()`), and realpath'd when they exist. No filesystem access
// happens at import time.
// ---------------------------------------------------------------------------

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * The anchor realpaths.
 *  - Normal mode: the whole data dir (sandboxes, worktrees, profiles), `configDir()` and `~/.claude`.
 *  - Sandbox mode (#0038): the profile home, `configDir()` and `claudeHome()`. The whole data dir is NOT
 *    an anchor there: the app runs from a worktree under `sandboxes/`, and that worktree is the discovery
 *    root. This is the carve-out the old workspace-discovery had.
 */
function anchors(): string[] {
  const realHome = resolveRealHome()
  const list = isInSandbox() ? [coHome(), configDir(), claudeHome()] : [realDataRoot(realHome), configDir(), sandboxPaths(realHome).claudeDir]
  return list.map(realOrSelf)
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent === path.sep ? parent : parent + path.sep)
}

/** True when `real` is an anchor, inside one, or an ANCESTOR of one. `real` must already be a realpath. */
export function overlapsAnchored(real: string): boolean {
  return anchors().some((a) => isInside(real, a) || isInside(a, real))
}

/**
 * Sandbox mode only: is `real` a sandbox worktree, i.e. at or inside `<sandboxesRoot>/<id>` where `<id>` is one
 * valid id segment? The sandboxes root itself, and anything else under `~/.corner-office`, is not.
 */
function isSandboxWorktree(real: string, realHome: string): boolean {
  const root = realOrSelf(sandboxPaths(realHome).sandboxesRoot)
  if (!real.startsWith(root + path.sep)) return false
  const id = real.slice(root.length + 1).split(path.sep)[0]
  return SANDBOX_SLUG_RE.test(id)
}

/**
 * The single "this is the app's own folder" predicate (I1): `overlapsAnchored`, or inside any
 * `hiddenHomeSegments()` entry under `home` (`~/.codex`, `~/.claude.json`, ...). In sandbox mode the real app's
 * default config dir is refused too.
 *
 * It is strict in every mode, with NO carve-out, because the sandbox mount guard (`insideAppState`) shares it and
 * must never be widened. A workspace is judged by `isRefusedAsWorkspace` below.
 */
export function isAppFolder(real: string, home: string): boolean {
  if (overlapsAnchored(real)) return true
  const extra = isInSandbox() ? [realOrSelf(defaultConfigDir(resolveRealHome()))] : []
  if (extra.some((a) => isInside(real, a) || isInside(a, real))) return true
  return hiddenHomeSegments().some((segment) => isInside(real, path.join(home, segment)))
}

/**
 * Is `real` AT or INSIDE one of the app's folders (an ancestor does not count)? For a folder that is only a
 * container for a new workspace ("Create new" under `$HOME`): the new folder, not its parent, is judged for
 * ancestry. Same sandbox-worktree carve-out as `isRefusedAsWorkspace`.
 */
export function isInsideAppFolder(real: string, home: string): boolean {
  const insideAnchor = (list: string[]) => list.some((a) => isInside(real, a))
  if (isInSandbox() && isSandboxWorktree(real, resolveRealHome())) return insideAnchor(anchors())
  const extra = isInSandbox() ? [realOrSelf(defaultConfigDir(resolveRealHome()))] : []
  if (insideAnchor([...anchors(), ...extra])) return true
  return hiddenHomeSegments().some((segment) => isInside(real, path.join(home, segment)))
}

/**
 * Is `real` refused as a WORKSPACE or docs root? `isAppFolder`, with one carve-out. In sandbox mode (#0038) the app
 * runs from a worktree under `~/.corner-office/sandboxes/<id>`, and that worktree must stay a valid workspace; the
 * mode's own anchors (the profile home, its config dir, its claude home) still apply to it. The sandboxes root itself,
 * every other data dir and the default config dir stay refused. Only the registry's candidate and docs-root
 * validation use this; the mount guard uses the strict `isAppFolder`.
 */
export function isRefusedAsWorkspace(real: string, home: string): boolean {
  if (isInSandbox() && isSandboxWorktree(real, resolveRealHome())) return overlapsAnchored(real)
  return isAppFolder(real, home)
}
