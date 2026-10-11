import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import type { AgentConfigResult, QuarantineOutcome } from '../handler'
import type { SandboxPaths } from '../../services/sandbox-paths'
import { readRegularFileCappedSync } from '../../services/safe-fs'
import { GUARD_BASELINE_FILE, clearCodexState, codexStatePaths, inGuardNameSet, prepareCodexConfig, writeOwnedFile } from './sandbox-config'

// ---------------------------------------------------------------------------
// codex/guard.ts — the minimal guard (#0037 D9, TRD D24 narrowed, §4.9.6, SM-1,
// SM-2). Codex in the sandbox can write `~/.codex`, and the host's Codex would load
// some of what it writes (`AGENTS.override.md`, `*.config.toml`, `.env*`,
// `hooks.json`, a symlink). After a session the guard moves such NEW top-level
// entries into `S/codex-quarantine` (or renames them in place across a
// filesystem boundary). It is a sweep only: no watcher.
//
// The baseline in `S/codex-guard-baseline.json` has two states. While `open` (a
// session is running, or crashed), the sweep compares against it. Once `closed`
// (confirmed stop, swept), files the user creates on the host between sessions are
// never touched. Paths are logged, never contents.
// ---------------------------------------------------------------------------

export { GUARD_BASELINE_FILE, inGuardNameSet }

type BaselineState = 'open' | 'closed'
/** What a baselined top-level entry was: a regular file, a directory, or anything else (a link, a socket). */
type EntryKind = 'file' | 'dir' | 'other'
interface Baseline {
  state: BaselineState
  names: string[]
  /** Absent in a baseline written before kinds were recorded: no swap check is made then. */
  kinds?: Record<string, EntryKind>
}

const BASELINE_READ_CAP = 1024 * 1024
const MAX_TOP_LEVEL_NAMES = 10_000
/** Names that are shown in a notice and used in a quarantine file name. */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

const NO_QUARANTINE: QuarantineOutcome = { quarantined: 0, shown: null, destination: null }

function readBaseline(file: string): Baseline | null {
  const read = readRegularFileCappedSync(file, BASELINE_READ_CAP)
  if (read === null || read.size > BASELINE_READ_CAP) return null
  try {
    const parsed: unknown = JSON.parse(read.buf.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { state, names, kinds } = parsed as { state?: unknown; names?: unknown; kinds?: unknown }
    if ((state !== 'open' && state !== 'closed') || !Array.isArray(names) || !names.every((n) => typeof n === 'string')) return null
    if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) return { state, names }
    const clean: Record<string, EntryKind> = Object.create(null)
    for (const [name, kind] of Object.entries(kinds)) if (kind === 'file' || kind === 'dir' || kind === 'other') clean[name] = kind
    return { state, names, kinds: clean }
  } catch {
    return null // unreadable means "no baseline": the guard then touches nothing it cannot prove is new
  }
}

function writeBaseline(file: string, baseline: Baseline): void {
  const result = writeOwnedFile(file, JSON.stringify(baseline), 0o600, 'the Codex guard baseline')
  if (!result.ok) throw new Error('could not write the guard baseline')
}

/** One bounded `readdir` of the top level of `H`. More entries than the cap is a failure, so the guard never works from a partial view. */
function topLevelNames(home: string): string[] {
  const names = fs.readdirSync(home)
  if (names.length > MAX_TOP_LEVEL_NAMES) throw new Error('too many entries in the Codex home')
  return names
}

/** The current top-level names with their kinds, for the baseline. */
function snapshot(home: string): { names: string[]; kinds: Record<string, EntryKind> } {
  const names = topLevelNames(home)
  const kinds: Record<string, EntryKind> = Object.create(null)
  for (const name of names) {
    try {
      const stat = fs.lstatSync(path.join(home, name))
      kinds[name] = stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other'
    } catch {
      kinds[name] = 'other' // gone since the listing
    }
  }
  return { names, kinds }
}

/**
 * Moves out of `H` every new top-level entry that is in the name set or is a symlink, and every baselined file or
 * directory that is now a symlink (the container swapped `auth.json` or `sessions` for a link the host's Codex
 * would follow). A baselined symlink was the user's and stays. `renameSync` acts on the link itself, never its
 * target. Across a filesystem boundary (EXDEV) the entry is renamed in place instead. A failure throws; the
 * entries moved so far stay moved.
 */
function sweep(paths: SandboxPaths, slug: string, baseline: Baseline, now: number): QuarantineOutcome {
  const baselineNames = new Set(baseline.names)
  const home = paths.codexDir
  const quarantineDir = codexStatePaths(paths, slug).quarantine
  const stat = fs.lstatSync(quarantineDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('the quarantine folder is not a real folder')

  const moved: { shown: string | null; destination: string }[] = []
  let unsafeCount = 0
  for (const name of topLevelNames(home)) {
    const source = path.join(home, name)
    let isLink: boolean
    try {
      isLink = fs.lstatSync(source).isSymbolicLink()
    } catch {
      continue // gone since the listing
    }
    if (baselineNames.has(name)) {
      const was = baseline.kinds?.[name]
      if (!isLink || (was !== 'file' && was !== 'dir')) continue
    } else if (!isLink && !inGuardNameSet(name)) {
      continue
    }

    const safe = SAFE_NAME_RE.test(name)
    const destName = safe ? `${name}-${now}` : `${now}-${++unsafeCount}`
    let destination: string
    try {
      fs.renameSync(source, path.join(quarantineDir, destName))
      destination = `~/.corner-office/sandbox/${slug}/codex-quarantine/${destName}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      const inPlace = `.${safe ? name : 'file'}.co-quarantined-${now}`
      fs.renameSync(source, path.join(home, inPlace))
      destination = `~/.codex/${inPlace}`
    }
    log.info(`[codex-guard] quarantined ${JSON.stringify(name)} for ${slug}`)
    moved.push({ shown: safe ? name : null, destination })
  }
  if (moved.length === 0) return NO_QUARANTINE
  return moved.length === 1
    ? { quarantined: 1, shown: moved[0].shown, destination: moved[0].destination }
    : { quarantined: moved.length, shown: null, destination: null }
}

/**
 * Called inside `prepare('plan')`. If the baseline is `open` (a crash or a missed stop) sweep first, then record
 * the current top-level names as `open`. Fails closed: if the guard cannot check, nothing starts.
 */
export function openCodexGuard(paths: SandboxPaths, slug: string, now: number = Date.now()): AgentConfigResult {
  try {
    const file = path.join(codexStatePaths(paths, slug).state, GUARD_BASELINE_FILE)
    const baseline = readBaseline(file)
    const outcome = baseline?.state === 'open' ? sweep(paths, slug, baseline, now) : NO_QUARANTINE
    writeBaseline(file, { state: 'open', ...snapshot(paths.codexDir) })
    return outcome.quarantined > 0 ? { ok: true, quarantine: outcome } : { ok: true }
  } catch (err) {
    log.warn(`[codex-guard] could not check the Codex home for ${slug}: ${String(err)}`)
    return { ok: false, detail: "Corner Office couldn't check ~/.codex before starting, so nothing was started." }
  }
}

/**
 * Called after a *confirmed* stop, and in reconcile: sweep against an `open` baseline, then write `closed`. A failure
 * throws before `closed` is written, so the baseline stays `open` and the next prepare retries.
 */
export function closeCodexGuard(paths: SandboxPaths, slug: string, now: number = Date.now()): QuarantineOutcome {
  const file = path.join(codexStatePaths(paths, slug).state, GUARD_BASELINE_FILE)
  const baseline = readBaseline(file)
  const outcome = baseline?.state === 'open' ? sweep(paths, slug, baseline, now) : NO_QUARANTINE
  writeBaseline(file, { state: 'closed', ...snapshot(paths.codexDir) })
  return outcome
}

/**
 * Delete: the closing sweep runs before the baseline goes, so a file planted during the last session can't outlive
 * the evidence. If the sweep fails the baseline is kept (still `open`), and the failure is logged, never thrown.
 */
export function cleanupCodexSession(paths: SandboxPaths, slug: string): void {
  let swept = true
  try {
    const outcome = closeCodexGuard(paths, slug)
    if (outcome.quarantined > 0) log.info(`[codex-guard] delete sweep for ${slug} quarantined ${outcome.quarantined} entries`)
  } catch (err) {
    swept = false
    log.warn(`[codex-guard] delete could not sweep the Codex home for ${slug}: ${String(err)}`)
  }
  clearCodexState(paths, slug, !swept)
}

/** `prepare('plan')` for Codex: the config (D8), then the guard's open. The guard is last so its baseline includes what precreate added. */
export function prepareCodexSession(paths: SandboxPaths, slug: string, workTree: string): AgentConfigResult {
  const config = prepareCodexConfig(paths, slug, workTree)
  return config.ok ? openCodexGuard(paths, slug) : config
}
