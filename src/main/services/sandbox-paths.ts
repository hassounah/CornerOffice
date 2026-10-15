import fs from 'fs'
import os from 'os'
import path from 'path'
import { AGENT_DESCRIPTORS } from '../agents/descriptors'
import { coHomeOr } from './app-home'

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

/**
 * The hidden first segments under `$HOME` a sandbox mount may use (assertMountSafe
 * rule 4): `.corner-office` plus every agent's `homeEntries`. Snapshot-pinned, so a
 * new agent's entries show up in a security review.
 */
export function hiddenHomeSegments(): readonly string[] {
  return ['.corner-office', ...AGENT_DESCRIPTORS.flatMap((d) => d.homeEntries)].filter(
    (segment, i, all) => all.indexOf(segment) === i,
  )
}

/** A `homeEntries` entry with an extension (`.claude.json`) is a single-file mount, not a directory root. */
const isFileEntry = (entry: string): boolean => path.extname(entry) !== ''

export interface SandboxPaths {
  /** `<realHome>/.corner-office/sandboxes` — SANDBOXES_ROOT (TRD §3.2, Q2). One persistent git worktree per workspace. */
  sandboxesRoot: string
  /** `<realHome>/.corner-office/sandbox` — SANDBOX_STATE_ROOT (TRD §3.2). App-owned state, distinct from the worktrees themselves. */
  sandboxStateRoot: string
  /** `<realHome>/.claude` — read-write mount source shared with every sandbox. */
  claudeDir: string
  /** `<realHome>/.codex` — Codex's home (`H`), read-write mount source for a Codex sandbox (#0037 D6/D8). */
  codexDir: string
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

/** `<realHome>/.corner-office/profiles` — named dev profile homes (#0038 D3a). Never a mount source or target. */
export function profilesRoot(realHome: string): string {
  return path.join(realHome, '.corner-office', 'profiles')
}

/**
 * Derive every sandbox-related path from one `realHome` (SEC-M2). Pure and
 * synchronous: no filesystem access beyond what resolving `realHome` already
 * did.
 */
export function sandboxPaths(realHome: string, coHomeDir: string = coHomeOr(path.join(realHome, '.corner-office'))): SandboxPaths {
  // #0038: `sandboxesRoot` and `rwMountRoots` are security classifications ("agent-controlled")
  // and never follow the profile; only the app's own reads (`sandboxStateRoot`, `eventsRoot`) do.
  // `claudeDir` is what containers mount; `claudeHome()` is the directory this app reads.
  const sandboxesRoot = path.join(realHome, '.corner-office', 'sandboxes')
  const realSandboxStateRoot = path.join(realHome, '.corner-office', 'sandbox')
  const realEventsRoot = path.join(realHome, '.corner-office', 'events')
  const sandboxStateRoot = path.join(coHomeDir, 'sandbox')
  const claudeDir = path.join(realHome, '.claude')
  const codexDir = path.join(realHome, '.codex')
  const claudeJson = path.join(realHome, '.claude.json')
  const claudeSettings = path.join(claudeDir, 'settings.json')
  const claudeMd = path.join(claudeDir, 'CLAUDE.md')
  const claudeSettingsLocal = path.join(claudeDir, 'settings.local.json')
  const claudeRoDirs = ['plugins', 'commands', 'agents', 'skills', 'hooks'].map((d) => path.join(claudeDir, d))
  const claudeShadowDirs = ['shell-snapshots', 'session-env', 'backups', 'security', 'ide'].map((d) => path.join(claudeDir, d))
  const eventsRoot = path.join(coHomeDir, 'events')

  return {
    sandboxesRoot,
    sandboxStateRoot,
    claudeDir,
    codexDir,
    claudeJson,
    claudeSettings,
    claudeMd,
    claudeSettingsLocal,
    claudeRoDirs,
    claudeShadowDirs,
    eventsRoot,
    rwMountRoots: [
      ...AGENT_DESCRIPTORS.flatMap((d) => d.homeEntries)
        .filter((entry) => !isFileEntry(entry))
        .map((entry) => path.join(realHome, entry)),
      sandboxesRoot,
      realSandboxStateRoot,
      realEventsRoot,
    ],
  }
}
