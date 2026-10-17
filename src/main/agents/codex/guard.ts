import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import type { AgentConfigResult, QuarantineOutcome } from '../handler'
import type { SandboxPaths } from '../../services/sandbox-paths'
import { readRegularFileCappedSync } from '../../services/safe-fs'
import { coHomeDisplay } from '../../services/app-home'
import { GUARD_ACTIVE_FILE, GUARD_BASELINE_FILE, SOCKET_WALK_SKIP, clearCodexState, codexStatePaths, inGuardNameSet, prepareCodexConfig, writeOwnedFile } from './sandbox-config'

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
  /** Symlinks found by the bounded walk, relative path -> target. Absent in an older baseline: no link check is made then. */
  links?: Record<string, string>
}

const BASELINE_READ_CAP = 1024 * 1024
const MAX_TOP_LEVEL_NAMES = 10_000
const LINK_WALK_MAX_DEPTH = 4
const LINK_WALK_MAX_ENTRIES = 20_000
const MAX_LINKS = 1_000
const LINK_TARGET_CAP = 4096
/** Names that are shown in a notice and used in a quarantine file name. */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

const NO_QUARANTINE: QuarantineOutcome = { quarantined: 0, shown: null, destination: null }

function readBaseline(file: string): Baseline | null {
  const read = readRegularFileCappedSync(file, BASELINE_READ_CAP)
  if (read === null || read.size > BASELINE_READ_CAP) return null
  try {
    const parsed: unknown = JSON.parse(read.buf.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { state, names, kinds, links } = parsed as { state?: unknown; names?: unknown; kinds?: unknown; links?: unknown }
    if ((state !== 'open' && state !== 'closed') || !Array.isArray(names) || !names.every((n) => typeof n === 'string')) return null
    const baseline: Baseline = { state, names }
    if (typeof kinds === 'object' && kinds !== null && !Array.isArray(kinds)) {
      const clean: Record<string, EntryKind> = Object.create(null)
      for (const [name, kind] of Object.entries(kinds)) if (kind === 'file' || kind === 'dir' || kind === 'other') clean[name] = kind
      baseline.kinds = clean
    }
    if (typeof links === 'object' && links !== null && !Array.isArray(links)) {
      const clean: Record<string, string> = Object.create(null)
      for (const [rel, target] of Object.entries(links)) if (typeof target === 'string') clean[rel] = target
      baseline.links = clean
    }
    return baseline
  } catch {
    return null // unreadable means "no baseline": the guard then touches nothing it cannot prove is new
  }
}

/**
 * A baseline over the read cap would read back as "no baseline" and leave the guard blind, so it is never written.
 * Written to a temp file in the same folder, fsynced, then renamed over the old one: a crash leaves the old baseline or
 * the new one, never an empty one. `O_EXCL | O_NOFOLLOW` on the temp file and `rename` (which replaces a link rather
 * than following it) keep a planted link from redirecting the write.
 */
function writeBaseline(file: string, baseline: Baseline): void {
  const json = JSON.stringify(baseline)
  if (Buffer.byteLength(json) > BASELINE_READ_CAP) throw new Error('the guard baseline is too large')
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const temp = `${file}.tmp`
  fs.rmSync(temp, { force: true })
  const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    fs.writeSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * What the guard knows about the last session. `untrusted` is a lost or damaged baseline in a workspace whose guard
 * has opened before (the active marker is there): that is not a first run, so nothing may be blessed as the baseline.
 */
function guardState(paths: SandboxPaths, slug: string): { baseline: Baseline | null; untrusted: boolean } {
  const state = codexStatePaths(paths, slug).state
  const baseline = readBaseline(path.join(state, GUARD_BASELINE_FILE))
  return { baseline, untrusted: baseline === null && exists(path.join(state, GUARD_ACTIVE_FILE)) }
}

/** One bounded `readdir` of the top level of `H`. More entries than the cap is a failure, so the guard never works from a partial view. */
function topLevelNames(home: string): string[] {
  const names = fs.readdirSync(home)
  if (names.length > MAX_TOP_LEVEL_NAMES) throw new Error('too many entries in the Codex home')
  return names
}

/** The current top-level names with their kinds, and the symlinks below them, for the baseline. */
function snapshot(home: string): { names: string[]; kinds: Record<string, EntryKind>; links: Record<string, string> } {
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
  const walk = walkLinks(home)
  if (walk.overflow) throw new Error('too many entries or symlinks in the Codex home to record a baseline')
  return { names, kinds, links: Object.fromEntries(walk.links) }
}

/** `readlink`, capped, so a huge target can't grow the baseline. */
function linkTarget(p: string): string {
  return fs.readlinkSync(p).slice(0, LINK_TARGET_CAP)
}

function sameTarget(p: string, expected: string): boolean {
  try {
    return linkTarget(p) === expected
  } catch {
    return true // gone since the listing: nothing to move
  }
}

/**
 * Every symlink in `H` down to `LINK_WALK_MAX_DEPTH` path components, relative path -> target. A bounded breadth-first
 * `Dirent` walk that never follows a link. The shadowed and session directories are not entered (they are not the
 * host's, or are the documented residual). Going over the entry or link cap stops the walk and sets `overflow`: the
 * links found so far are returned (the sweep still acts on them) but the view is partial, so no baseline is made from it.
 */
function walkLinks(home: string): { links: Map<string, string>; overflow: boolean } {
  const links = new Map<string, string>()
  let seen = 0
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: home, rel: '', depth: 0 }]
  while (queue.length > 0) {
    const { dir, rel, depth } = queue.shift() as { dir: string; rel: string; depth: number }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (depth === 0) throw err
      continue // a directory that vanished or can't be read
    }
    for (const entry of entries) {
      if (++seen > LINK_WALK_MAX_ENTRIES) return { links, overflow: true }
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        if (links.size >= MAX_LINKS) return { links, overflow: true }
        try {
          links.set(entryRel, linkTarget(full))
        } catch {
          // gone since the listing
        }
      } else if (entry.isDirectory() && depth + 1 < LINK_WALK_MAX_DEPTH && !(depth === 0 && SOCKET_WALK_SKIP.has(entry.name))) {
        queue.push({ dir: full, rel: entryRel, depth: depth + 1 })
      }
    }
  }
  return { links, overflow: false }
}

/**
 * Moves out of `H` every new top-level entry that is in the name set or is a symlink, and every baselined file or
 * directory that is now a symlink (the container swapped `auth.json` or `sessions` for a link the host's Codex
 * would follow). A baselined symlink was the user's and stays, unless its target changed. Below the top level, any
 * symlink that is not in the baseline, or whose target changed, goes too (the host's Codex writes fixed-name files in
 * `memories/` and `shell_snapshots/`, and a planted link would turn that into an overwrite elsewhere). `renameSync`
 * acts on the link itself, never its target. Across a filesystem boundary (EXDEV) the entry is renamed in place
 * instead. A failure throws; the entries moved so far stay moved. If the link walk goes over its bounds the top-level
 * check still runs in full, plus every top-level directory that is not in the baseline (it may hold links the walk
 * could not see) is moved, and the outcome is `incomplete`.
 */
/** A sweep's outcome; `overflowed` (only when true) says the link walk went over its bounds, which Delete must not paper over. */
type SweepOutcome = QuarantineOutcome & { overflowed?: true }

function sweep(paths: SandboxPaths, slug: string, baseline: Baseline, now: number, untrusted = false): SweepOutcome {
  const baselineNames = new Set(baseline.names)
  const home = paths.codexDir
  const quarantineDir = codexStatePaths(paths, slug).quarantine
  const stat = fs.lstatSync(quarantineDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('the quarantine folder is not a real folder')

  // Nested links: the walk is over the tree as it is now, before anything moves. An overflow does not stop the
  // top-level check, and the links found before the bound are still acted on.
  let nested: [string, string][] = []
  let overflowed = false
  if (baseline.links) {
    const walk = walkLinks(home)
    nested = [...walk.links].filter(([rel]) => rel.includes('/'))
    overflowed = walk.overflow
    if (overflowed) log.warn(`[codex-guard] link walk for ${slug} went over its bounds`)
  }
  // A lost baseline (`untrusted`) is checked as far as it can be, with an empty one, and is just as incomplete.
  if (untrusted) log.warn(`[codex-guard] the guard baseline for ${slug} is missing or damaged; checking without it`)

  const moved: { shown: string | null; destination: string }[] = []
  const movedTop = new Set<string>()
  let unsafeCount = 0
  const quarantine = (rel: string): void => {
    const source = path.join(home, rel)
    const name = path.basename(rel)
    const flat = rel.split('/').join('_')
    const top = rel === name
    const safe = SAFE_NAME_RE.test(flat)
    const destName = safe ? freeName(quarantineDir, `${flat}-${now}`) : freeName(quarantineDir, `${now}-${++unsafeCount}`)
    let destination: string
    try {
      fs.renameSync(source, path.join(quarantineDir, destName))
      destination = `${coHomeDisplay()}/sandbox/${slug}/codex-quarantine/${destName}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      const inPlace = freeName(path.dirname(source), `.${SAFE_NAME_RE.test(name) ? name : 'file'}.co-quarantined-${now}`)
      fs.renameSync(source, path.join(path.dirname(source), inPlace))
      destination = `~/.codex/${top ? '' : `${path.dirname(rel)}/`}${inPlace}`
    }
    if (top) movedTop.add(rel)
    log.info(`[codex-guard] quarantined ${JSON.stringify(rel)} for ${slug}`)
    // Only a top-level name can be put back as `~/.codex/<name>`; a nested one is shown by count and folder.
    moved.push({ shown: safe && top ? name : null, destination })
  }

  // The whole top level, uncapped: `Dirent` types need no extra syscall, and a cap here would let a container hide a
  // planted file behind thousands of junk entries. Going over the snapshot cap only makes the outcome incomplete.
  const topEntries = fs.readdirSync(home, { withFileTypes: true })
  if (topEntries.length > MAX_TOP_LEVEL_NAMES) {
    overflowed = true
    log.warn(`[codex-guard] the Codex home for ${slug} has more top-level entries than the guard records`)
  }
  for (const entry of topEntries) {
    const name = entry.name
    const isLink = entry.isSymbolicLink()
    const isDir = entry.isDirectory()
    // Only against a trusted baseline: with none, every directory looks new, and moving them would strip the user's host Codex.
    if (overflowed && !untrusted && isDir && !baselineNames.has(name)) {
      quarantine(name)
      continue
    }
    if (baselineNames.has(name)) {
      const was = baseline.kinds?.[name]
      if (!isLink) continue
      if (was === 'file' || was === 'dir') {
        quarantine(name)
      } else if (baseline.links && name in baseline.links && !sameTarget(path.join(home, name), baseline.links[name])) {
        quarantine(name) // the user's link, pointed somewhere else
      }
      continue
    }
    if (isLink || inGuardNameSet(name)) quarantine(name)
  }
  for (const [rel, target] of nested) {
    if (movedTop.has(rel.split('/')[0])) continue // it went with its directory
    if (!baseline.links || !(rel in baseline.links) || baseline.links[rel] !== target) quarantine(rel)
  }
  const incomplete = overflowed || untrusted
  const flag = incomplete ? { incomplete: true, ...(untrusted ? { lostBaseline: true } : {}), ...(overflowed ? { overflowed: true } : {}) } : {}
  if (moved.length === 0) return { ...NO_QUARANTINE, ...flag }
  if (moved.length === 1) return { quarantined: 1, shown: moved[0].shown, destination: moved[0].destination, ...flag }
  // Several files: the folder, when every one of them went there (none was renamed in place across a filesystem).
  const folder = `${coHomeDisplay()}/sandbox/${slug}/${path.basename(quarantineDir)}/`
  const allInFolder = moved.every((m) => m.destination.startsWith(folder))
  return { quarantined: moved.length, shown: null, destination: allInFolder ? folder : null, ...flag }
}

/** `base`, or `base.<n>` when something already has that name in `dir`: `renameSync` would silently replace it. */
function freeName(dir: string, base: string): string {
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : `${base}.${n}`
    try {
      fs.lstatSync(path.join(dir, candidate))
    } catch {
      return candidate
    }
  }
  throw new Error('no free name in the quarantine folder')
}

/** Sweeps against an `open` baseline, or against nothing when the baseline was lost; a closed baseline or a first run needs no sweep. */
function sweepIfNeeded(paths: SandboxPaths, slug: string, now: number): SweepOutcome {
  const { baseline, untrusted } = guardState(paths, slug)
  // `links: {}` too: with nothing known to be the user's, every symlink below the top level goes as well.
  if (untrusted) return sweep(paths, slug, { state: 'open', names: [], links: {} }, now, true)
  return baseline?.state === 'open' ? sweep(paths, slug, baseline, now) : NO_QUARANTINE
}

const OPEN_REFUSED = "Corner Office couldn't check ~/.codex before starting, so nothing was started."

/**
 * Called inside `prepare('plan')`. If the baseline is `open` (a crash or a missed stop) sweep first, then record
 * the current top-level names as `open`. Fails closed: if the guard cannot check, nothing starts. A lost baseline is
 * never replaced by one made from the current files, and what the sweep moved before a refusal travels with it.
 */
export function openCodexGuard(paths: SandboxPaths, slug: string, now: number = Date.now()): AgentConfigResult {
  let outcome: QuarantineOutcome | null = null
  try {
    const state = codexStatePaths(paths, slug).state
    outcome = sweepIfNeeded(paths, slug, now)
    // The check could not finish (too much to walk, or no baseline to compare with): the baseline stays as it was.
    if (outcome.incomplete) {
      log.warn(`[codex-guard] the Codex home for ${slug} could not be fully checked; nothing was started`)
      return { ok: false, detail: OPEN_REFUSED, quarantine: outcome }
    }
    // The baseline first, then the marker: a failure in between must not leave a marker with no baseline, which reads as a lost one.
    writeBaseline(path.join(state, GUARD_BASELINE_FILE), { state: 'open', ...snapshot(paths.codexDir) })
    const marker = writeOwnedFile(path.join(state, GUARD_ACTIVE_FILE), '', 0o600, 'the Codex guard marker')
    if (!marker.ok) throw new Error(marker.detail)
    return outcome.quarantined > 0 ? { ok: true, quarantine: outcome } : { ok: true }
  } catch (err) {
    log.warn(`[codex-guard] could not check the Codex home for ${slug}: ${String(err)}`)
    // After a finished sweep, say what it moved and that the check did not complete.
    return outcome ? { ok: false, detail: OPEN_REFUSED, quarantine: { ...outcome, incomplete: true } } : { ok: false, detail: OPEN_REFUSED }
  }
}

/**
 * Called after a *confirmed* stop, and in reconcile: sweep against an `open` baseline, then write `closed`. A sweep
 * that throws leaves the baseline `open` for the next prepare. A sweep that finished but could not close (too much to
 * record, or a failed write) returns its outcome as `incomplete`, so the user hears of it; the baseline stays `open`.
 */
export function closeCodexGuard(paths: SandboxPaths, slug: string, now: number = Date.now()): QuarantineOutcome {
  const outcome = sweepIfNeeded(paths, slug, now)
  if (outcome.incomplete) return outcome // what was found is moved and reported; the baseline stays `open` so the next check finishes the job
  try {
    writeBaseline(path.join(codexStatePaths(paths, slug).state, GUARD_BASELINE_FILE), { state: 'closed', ...snapshot(paths.codexDir) })
  } catch (err) {
    log.warn(`[codex-guard] could not record the closed baseline for ${slug}: ${String(err)}`)
    return { ...outcome, incomplete: true }
  }
  return outcome
}

/** Pure: a session ended (crash, power loss, daemon restart) without its closing sweep, or its baseline was lost. Reconcile then runs `closeCodexGuard` once the container is down. */
export function codexGuardIsOpen(paths: SandboxPaths, slug: string): boolean {
  const { baseline, untrusted } = guardState(paths, slug)
  return untrusted || baseline?.state === 'open'
}

/**
 * Delete: the closing sweep runs before the baseline goes, so a file planted during the last session can't outlive
 * the evidence. If the sweep fails the baseline is kept (still `open`), and the failure is logged, never thrown.
 * When the container is not confirmed gone it may still be running: nothing is swept or closed, the baseline stays
 * `open`, and reconcile sweeps once the container is down.
 */
export function cleanupCodexSession(paths: SandboxPaths, slug: string, containerAbsent = true): void {
  if (!containerAbsent) {
    log.warn(`[codex-guard] the Codex container for ${slug} is not confirmed removed; the guard baseline is kept open`)
    clearCodexState(paths, slug, true)
    return
  }
  let swept = true
  try {
    const outcome = sweepIfNeeded(paths, slug, Date.now())
    if (outcome.quarantined > 0) log.info(`[codex-guard] delete sweep for ${slug} quarantined ${outcome.quarantined} entries`)
    // A lost baseline alone does not stop Delete: everything the sweep could see has been moved, and the state (marker
    // included) goes, which is the way back to a working sandbox. A walk over its bounds does stop it.
    if (outcome.incomplete && !(outcome.lostBaseline && !outcome.overflowed)) {
      swept = false
      log.warn(`[codex-guard] delete could not finish checking the Codex home for ${slug}`)
    }
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
