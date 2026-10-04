import fs from 'fs'
import os from 'os'
import path from 'path'

// ---------------------------------------------------------------------------
// sandbox-paths.ts — the single source of every sandbox-related host path
// (TRD §3.2, SEC-M2).
//
// `os.homedir()` can be a symlink. `assertMountSafe` (step 1.4) requires
// every mount source to equal its own realpath, so building sandbox paths
// from the unresolved home would make every workspace `unsafe-path` — and
// the "fix" a developer would reach for is to relax that realpath rule,
// which is exactly what stops a symlink-redirected mount (H1). Instead,
// `resolveRealHome()` resolves `os.homedir()` to its realpath once, lazily,
// and caches it; `sandboxPaths(realHome)` derives every path from that one
// value. Every sandbox path, the L5 refusal roots, the container `HOME` and
// `specHash` (steps 1.2, 1.4–1.6, 3.4) must all be built from the same
// `resolveRealHome()` call — never from `os.homedir()` directly.
//
// No filesystem access happens at import time (`security.test.ts` imports
// `main/index.ts` with a partial `fs` mock): `resolveRealHome()` only
// touches `fs` when a caller actually invokes it.
// ---------------------------------------------------------------------------

export interface SandboxPaths {
  /** `<realHome>/.corner-office/sandboxes` — SANDBOXES_ROOT (TRD §3.2, Q2). One persistent git worktree per workspace. */
  sandboxesRoot: string
  /** `<realHome>/.corner-office/sandbox` — SANDBOX_STATE_ROOT (TRD §3.2). App-owned state, distinct from the worktrees themselves. */
  sandboxStateRoot: string
  /** `<realHome>/.claude` — read-write mount source shared with every sandbox. */
  claudeDir: string
  /** `<realHome>/.claude.json` — single-file read-write bind mount. */
  claudeJson: string
  /** `<realHome>/.claude/settings.json` — host original; a sanitized per-sandbox copy is mounted over it read-only. */
  claudeSettings: string
  /** `<realHome>/.claude/CLAUDE.md` — read-only mount. */
  claudeMd: string
  /** `<realHome>/.claude/settings.local.json` — read-only mount, so the agent can't plant one the host may load. */
  claudeSettingsLocal: string
  /** `<realHome>/.claude/{plugins,commands,agents,skills,hooks}` — read-only mounts layered over `claudeDir`. */
  claudeRoDirs: readonly string[]
  /**
   * `<realHome>/.claude/{shell-snapshots,session-env,backups,security,ide}` — host-executed state the
   * in-container Claude Code also writes, so each is shadowed by a per-sandbox read-write dir (#0030 C1).
   */
  claudeShadowDirs: readonly string[]
  /** `<realHome>/.corner-office/events` — read-write mount source for host/sandbox event attribution. */
  eventsRoot: string
  /**
   * Every read-write mount source an agent inside a container can write to.
   * Used as the L5 refusal roots: a `git` or `docker` binary resolved
   * through a PATH entry whose realpath lies under one of these is refused
   * (step 1.2, TRD §3.3 v2/L5). Deliberately excludes `claudeJson`, which is
   * a single-file mount, not a directory root.
   */
  rwMountRoots: readonly string[]
}

let _realHome: string | null = null

/**
 * One lazily resolved, cached `realpath(os.homedir())` (SEC-M2). Every
 * sandbox path must be derived from this single value — never call
 * `os.homedir()` directly elsewhere in the sandbox subsystem. Performs no
 * filesystem access until first called.
 */
export function resolveRealHome(): string {
  if (_realHome === null) _realHome = fs.realpathSync(os.homedir())
  return _realHome
}

/**
 * Derive every sandbox-related path from one `realHome` (SEC-M2). Pure and
 * synchronous: no filesystem access beyond what resolving `realHome` already
 * did.
 */
export function sandboxPaths(realHome: string): SandboxPaths {
  const sandboxesRoot = path.join(realHome, '.corner-office', 'sandboxes')
  const sandboxStateRoot = path.join(realHome, '.corner-office', 'sandbox')
  const claudeDir = path.join(realHome, '.claude')
  const claudeJson = path.join(realHome, '.claude.json')
  const claudeSettings = path.join(claudeDir, 'settings.json')
  const claudeMd = path.join(claudeDir, 'CLAUDE.md')
  const claudeSettingsLocal = path.join(claudeDir, 'settings.local.json')
  const claudeRoDirs = ['plugins', 'commands', 'agents', 'skills', 'hooks'].map((d) => path.join(claudeDir, d))
  const claudeShadowDirs = ['shell-snapshots', 'session-env', 'backups', 'security', 'ide'].map((d) => path.join(claudeDir, d))
  const eventsRoot = path.join(realHome, '.corner-office', 'events')

  return {
    sandboxesRoot,
    sandboxStateRoot,
    claudeDir,
    claudeJson,
    claudeSettings,
    claudeMd,
    claudeSettingsLocal,
    claudeRoDirs,
    claudeShadowDirs,
    eventsRoot,
    rwMountRoots: [claudeDir, sandboxesRoot, sandboxStateRoot, eventsRoot],
  }
}
