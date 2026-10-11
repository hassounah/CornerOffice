import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import { parse, stringify } from 'smol-toml'
import type { AgentConfigResult, AgentReadiness } from '../handler'
import type { SandboxPaths } from '../../services/sandbox-paths'
import { MAX_FILE_SIZE, readRegularFileCappedSync } from '../../services/safe-fs'
import { CODEX_DESCRIPTOR } from './descriptor'

// ---------------------------------------------------------------------------
// codex/sandbox-config.ts — what Codex in the sandbox is given of `~/.codex`
// (#0037 TRD §4.9.2-§4.9.5, D7, D8, D20, D25, SH-4, SM-1, SM-8). `H` is
// `~/.codex`; `S` is the workspace's state dir, `~/.corner-office/sandbox/<slug>`.
//
// Everything here is as the app user: entries are created with O_EXCL and never
// overwritten, nothing follows a symlink, and `H` itself is never created. Fixed
// copy only: a message names a file, never its contents.
// ---------------------------------------------------------------------------

/** Mount targets in `H`, precreated empty when absent. */
const HOST_FILES = ['.env', 'AGENTS.md', 'config.toml'] as const
/** `H` entries that are mounted read-only over themselves from the host: the code, prompts and instructions Codex loads. `packages` holds the standalone Codex binaries and the daemon package. */
const HOST_READONLY_ENTRIES = ['plugins', 'skills', 'prompts', 'agents', 'packages', 'AGENTS.md'] as const

/**
 * Directories of `H` that the container gets a per-workspace copy of instead (name in `H` -> dir in `S`). The one
 * list behind the mounts, the precreate, the cleanup and the socket walk. `tmp` holds the `arg0` PATH dirs and
 * `.tmp` the curated plugin clone: both feed code the host's Codex runs.
 */
const CODEX_SHADOWS = [
  { name: 'rules', dir: 'codex-rules', readonly: true },
  { name: 'app-server-daemon', dir: 'codex-daemon', readonly: true },
  { name: 'log', dir: 'codex-log', readonly: false },
  { name: 'tmp', dir: 'codex-tmp', readonly: false },
  { name: '.tmp', dir: 'codex-dottmp', readonly: false },
  { name: 'shell_snapshots', dir: 'codex-shell-snapshots', readonly: false },
] as const

/** Directories in `H` mounted read-only or shadowed, precreated 0700 when absent. */
const HOST_DIRS = [...HOST_READONLY_ENTRIES.filter((name) => name !== 'AGENTS.md'), ...CODEX_SHADOWS.map((shadow) => shadow.name)]

const STATE_FILES = ['codex-config.toml', 'codex-env'] as const
const STATE_DIRS = [...CODEX_SHADOWS.map((shadow) => shadow.dir), 'codex-sqlite', 'codex-quarantine']

/** Top-level keys of the host `config.toml` the sandbox keeps (everything else, and every other key, is dropped). */
const CARRIED_KEYS = ['model', 'model_provider', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'features', 'tui', 'plugins'] as const
/** The only `model_providers.<id>` sub-keys carried: no headers, tokens, query params or `auth`. */
const PROVIDER_KEYS = ['name', 'base_url', 'wire_api', 'env_key', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms'] as const

/** Defense in depth behind "no forge credentials" (§4.9.4). */
const PUSH_GUARD_RULES = [
  '# Written by Corner Office. Codex in the sandbox may not publish work.',
  'prefix_rule(pattern = ["git", "push"], decision = "forbidden", justification = "Corner Office sandbox: push from your own terminal.")',
  'prefix_rule(pattern = ["gh", "pr", "create"], decision = "forbidden", justification = "Corner Office sandbox: no forge access.")',
  'prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden", justification = "Corner Office sandbox: no forge access.")',
  'prefix_rule(pattern = ["gh", "api"], decision = "forbidden", justification = "Corner Office sandbox: no forge access.")',
  '',
].join('\n')

const SOCKET_WALK_MAX_DEPTH = 2
const SOCKET_WALK_MAX_ENTRIES = 5_000
/** Top-level entries of `H` the socket walk does not look into: shadowed (`app-server-daemon`, `log`) or session data. */
export const SOCKET_WALK_SKIP = new Set<string>(['sessions', 'archived_sessions', ...CODEX_SHADOWS.map((shadow) => shadow.name)])

// `fs.constants` is read inside the functions, never at import: several suites mock `fs` and import the registry.

type Kind = 'file' | 'dir'
type EntryState = 'ok' | 'missing' | 'symlink' | 'wrong-type'

function invalid(detail: string): Extract<AgentConfigResult, { ok: false }> {
  return { ok: false, detail }
}

/** lstat only: a symlink is never followed and never counts as the right type. */
function entryState(p: string, kind: Kind): EntryState {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(p)
  } catch {
    return 'missing'
  }
  if (stat.isSymbolicLink()) return 'symlink'
  return (kind === 'dir' ? stat.isDirectory() : stat.isFile()) ? 'ok' : 'wrong-type'
}

/** SM-1: the copy for a mounted or precreated entry that is a symlink or the wrong type. `where` is how the user sees the path. */
function problemDetail(where: string, state: Exclude<EntryState, 'ok' | 'missing'>, kind: Kind): string {
  if (state === 'symlink') return `${where} is a symbolic link. Replace it with a real file or folder, then Start again.`
  return `${where} ${kind === 'dir' ? "isn't a folder" : "isn't a regular file"}. Fix or remove it, then Start again.`
}

function couldNotCreate(where: string): Extract<AgentConfigResult, { ok: false }> {
  return invalid(`${where} couldn't be created. Check the folder's permissions and free space, then Start again.`)
}

/** Creates an empty regular file (O_EXCL, never overwrites); an existing entry must already be a real file. */
function ensureFile(p: string, mode: number, where: string): AgentConfigResult {
  try {
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    fs.closeSync(fs.openSync(p, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode))
    return { ok: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return couldNotCreate(where)
  }
  const state = entryState(p, 'file')
  return state === 'ok' ? { ok: true } : state === 'missing' ? couldNotCreate(where) : invalid(problemDetail(where, state, 'file'))
}

/** Creates a directory (never recursive here); an existing entry must already be a real directory. */
function ensureDir(p: string, mode: number, where: string): AgentConfigResult {
  try {
    fs.mkdirSync(p, { mode })
    // The umask must not widen it. Through a descriptor opened with O_NOFOLLOW, so a link swapped in for the new
    // directory is refused instead of having its target's mode changed.
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(p, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    try {
      fs.fchmodSync(fd, mode)
    } finally {
      fs.closeSync(fd)
    }
    return { ok: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return couldNotCreate(where)
  }
  const state = entryState(p, 'dir')
  return state === 'ok' ? { ok: true } : state === 'missing' ? couldNotCreate(where) : invalid(problemDetail(where, state, 'dir'))
}

/** Rewrites an app-owned file in place: O_NOFOLLOW, truncate, fsync. A symlink planted at `p` fails the open. */
export function writeOwnedFile(p: string, content: string, mode: number, where: string): AgentConfigResult {
  try {
    const { O_WRONLY, O_CREAT, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(p, O_WRONLY | O_CREAT | O_NOFOLLOW, mode)
    try {
      fs.ftruncateSync(fd, 0)
      fs.writeSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return { ok: true }
  } catch {
    const state = entryState(p, 'file')
    return state === 'symlink' || state === 'wrong-type' ? invalid(problemDetail(where, state, 'file')) : couldNotCreate(where)
  }
}

/** The per-workspace state dir `S` and the entries Codex's sandbox gets from it. */
export function codexStatePaths(paths: SandboxPaths, slug: string) {
  const state = path.join(paths.sandboxStateRoot, slug)
  return {
    state,
    configOverlay: path.join(state, 'codex-config.toml'),
    env: path.join(state, 'codex-env'),
    rulesDir: path.join(state, 'codex-rules'),
    rulesFile: path.join(state, 'codex-rules', 'corner-office.rules'),
    daemon: path.join(state, 'codex-daemon'),
    log: path.join(state, 'codex-log'),
    sqlite: path.join(state, 'codex-sqlite'),
    quarantine: path.join(state, 'codex-quarantine'),
  }
}

/**
 * The quarantine folder as the user sees it, when it exists and holds something (Delete keeps it: the confirm says
 * so). `null` otherwise. Pure: an lstat and a listing, never a write.
 */
export function codexQuarantineFolder(paths: SandboxPaths, slug: string): string | null {
  const dir = codexStatePaths(paths, slug).quarantine
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.readdirSync(dir).length === 0) return null
  } catch {
    return null
  }
  return `~/.corner-office/sandbox/${slug}/${path.basename(dir)}`
}

/** `H` exists and is a real directory (a symlink is not): the only case in which anything under it is touched. */
function homeIsRealDir(paths: SandboxPaths): boolean {
  return entryState(paths.codexDir, 'dir') === 'ok'
}

/** Mount targets and shadow roots in `H`. A no-op when `H` is not a real directory: `H` itself is never created. */
export function precreateCodexHome(paths: SandboxPaths): AgentConfigResult {
  if (!homeIsRealDir(paths)) return { ok: true }
  for (const name of HOST_FILES) {
    const result = ensureFile(path.join(paths.codexDir, name), 0o600, `~/.codex/${name}`)
    if (!result.ok) return result
  }
  for (const name of HOST_DIRS) {
    const result = ensureDir(path.join(paths.codexDir, name), 0o700, `~/.codex/${name}`)
    if (!result.ok) return result
  }
  return { ok: true }
}

/** The per-workspace state `S`: overlay and env sources, the push-guard rules, and the shadow/sqlite/quarantine dirs. */
export function precreateCodexState(paths: SandboxPaths, slug: string): AgentConfigResult {
  const s = codexStatePaths(paths, slug)
  const stateWhere = `~/.corner-office/sandbox/${slug}`
  const where = (name: string): string => `${stateWhere}/${name}`
  try {
    fs.mkdirSync(s.state, { recursive: true, mode: 0o700 })
  } catch {
    return couldNotCreate(stateWhere)
  }
  const stateState = entryState(s.state, 'dir')
  if (stateState === 'symlink' || stateState === 'wrong-type') return invalid(problemDetail(stateWhere, stateState, 'dir'))

  for (const name of STATE_FILES) {
    const result = ensureFile(path.join(s.state, name), 0o600, where(name))
    if (!result.ok) return result
  }
  for (const name of STATE_DIRS) {
    const result = ensureDir(path.join(s.state, name), 0o700, where(name))
    if (!result.ok) return result
  }
  return writeOwnedFile(s.rulesFile, PUSH_GUARD_RULES, 0o600, where('codex-rules/corner-office.rules'))
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** Pure: the sandbox's `config.toml` from the host's parsed one. The app keys are written last, so they win. */
export function buildOverlay(host: Record<string, unknown>, workTree: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of CARRIED_KEYS) if (host[key] !== undefined) out[key] = host[key]

  if (isTable(host.model_providers)) {
    const providers: Record<string, unknown> = {}
    for (const [id, provider] of Object.entries(host.model_providers)) {
      if (!isTable(provider)) continue
      const kept: Record<string, unknown> = {}
      for (const key of PROVIDER_KEYS) if (isScalar(provider[key])) kept[key] = provider[key]
      if (Object.keys(kept).length > 0) providers[id] = kept
    }
    if (Object.keys(providers).length > 0) out.model_providers = providers
  }

  out.cli_auth_credentials_store = 'file'
  out.check_for_update_on_startup = false
  out.features = { ...(isTable(out.features) ? out.features : {}), daemon_auto_start: false }
  out.projects = { [workTree]: { trust_level: 'trusted' } }
  return out
}

type HostConfig = { ok: true; value: Record<string, unknown> } | Extract<AgentConfigResult, { ok: false }>

/** The host `config.toml`, capped at 2 MB; a missing file reads as empty. Invalid TOML blocks Codex starts only. */
function readHostConfig(paths: SandboxPaths): HostConfig {
  const file = path.join(paths.codexDir, 'config.toml')
  const read = readRegularFileCappedSync(file, MAX_FILE_SIZE)
  if (read === null) return { ok: true, value: {} }
  if (read.size > MAX_FILE_SIZE) return invalid("~/.codex/config.toml is too large to copy into the sandbox. Make it smaller, then Start again.")
  try {
    return { ok: true, value: parse(read.buf.toString('utf8')) }
  } catch {
    return invalid("~/.codex/config.toml isn't valid TOML. Fix or remove it, then Start again.")
  }
}

/** Writes `S/codex-config.toml` from the host config on every prepare. */
export function writeOverlay(paths: SandboxPaths, slug: string, workTree: string): AgentConfigResult {
  const host = readHostConfig(paths)
  if (!host.ok) return host
  const overlay = stringify(buildOverlay(host.value, workTree))
  return writeOwnedFile(codexStatePaths(paths, slug).configOverlay, overlay, 0o600, `~/.corner-office/sandbox/${slug}/codex-config.toml`)
}

/**
 * A socket inside `H` that Codex in the sandbox could use to run commands on the host (D20). A bounded lstat
 * walk: depth <= 2, <= 5,000 entries, skipping the shadowed and session directories. Returns the relative path
 * of the first socket, or `null`. Overflow is logged and not a refusal (a documented residual).
 */
export function findHostSocket(home: string): string | null {
  let seen = 0
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: home, rel: '', depth: 0 }]
  while (queue.length > 0) {
    const { dir, rel, depth } = queue.shift() as { dir: string; rel: string; depth: number }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++seen > SOCKET_WALK_MAX_ENTRIES) {
        log.warn(`[codex-sandbox-config] socket walk stopped after ${SOCKET_WALK_MAX_ENTRIES} entries`)
        return null
      }
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isSocket()) return entryRel
      const skipped = depth === 0 && SOCKET_WALK_SKIP.has(entry.name)
      if (entry.isDirectory() && !skipped && depth < SOCKET_WALK_MAX_DEPTH) queue.push({ dir: path.join(dir, entry.name), rel: entryRel, depth: depth + 1 })
    }
  }
  return null
}

/** Refuses a host with a socket in `H` outside the shadowed directories. */
export function refuseHostSockets(paths: SandboxPaths): AgentConfigResult {
  if (!homeIsRealDir(paths)) return { ok: true }
  const socket = findHostSocket(paths.codexDir)
  if (socket === null) return { ok: true }
  return invalid(
    `~/.codex/${socket} is a socket that Codex in the sandbox could use to run commands on your computer. Stop the program that created it, then Start again.`,
  )
}

/** `prepare('plan')` for Codex: precreate `H` and `S`, refuse sockets, write the overlay. The first problem stops it. */
export function prepareCodexConfig(paths: SandboxPaths, slug: string, workTree: string): AgentConfigResult {
  if (!homeIsRealDir(paths)) return invalid(CODEX_DESCRIPTOR.copy.readiness['never-run'].message)
  for (const step of [
    () => precreateCodexHome(paths),
    () => verifyMountSources(paths.codexDir),
    () =>
      homeIsCaseInsensitive(paths.codexDir)
        ? invalid('Codex in the sandbox needs ~/.codex on a case-sensitive filesystem.')
        : ({ ok: true } as const),
    () => precreateCodexState(paths, slug),
    () => refuseHostSockets(paths),
    () => writeOverlay(paths, slug, workTree),
  ]) {
    const result = step()
    if (!result.ok) return result
  }
  return { ok: true }
}

/** Is a precreated or mounted entry of `H` a symlink or the wrong type? Missing entries are fine: precreate makes them. */
function homeEntryBroken(paths: SandboxPaths): boolean {
  const broken = (name: string, kind: Kind): boolean => {
    const state = entryState(path.join(paths.codexDir, name), kind)
    return state === 'symlink' || state === 'wrong-type'
  }
  return HOST_FILES.some((name) => broken(name, 'file')) || HOST_DIRS.some((name) => broken(name, 'dir'))
}

/** The sign-in store the host config asks for; `null` when it says nothing or can't be read. */
function authStore(paths: SandboxPaths): unknown {
  const read = readRegularFileCappedSync(path.join(paths.codexDir, 'config.toml'), MAX_FILE_SIZE)
  if (read === null || read.size > MAX_FILE_SIZE) return null
  try {
    return parse(read.buf.toString('utf8')).cli_auth_credentials_store ?? null
  } catch {
    return null
  }
}

export const GUARD_BASELINE_FILE = 'codex-guard-baseline.json'
/**
 * Written the first time a guard opens for a workspace and removed only by Delete (with the baseline). Its presence
 * with no readable baseline means the baseline was lost or damaged, which the guard must not mistake for a first run.
 */
export const GUARD_ACTIVE_FILE = 'codex-guard-active'

/**
 * What the host's Codex would load, or run, if the sandbox created it. A `.config.toml` of any other prefix, but never
 * `config.toml` itself. Matched on the NFC-normalized, lowercased name: a case-insensitive filesystem (macOS APFS) would
 * load `agents.OVERRIDE.md` too. Shared by the guard (D9) and the mounts (pre-existing matches are mounted read-only).
 */
export function inGuardNameSet(name: string): boolean {
  const n = name.normalize('NFC').toLowerCase()
  return n === 'agents.override.md' || n === 'hooks.json' || n.startsWith('.env') || (n.endsWith('.config.toml') && n !== 'config.toml')
}

/**
 * Codex's mounts (TRD §4.9.2): `H` read-write, then read-only overlays, shadows and the sqlite home on top.
 *
 *  - ro: the overlay over `config.toml`, the empty `S/codex-env` over `.env`, the code/prompt entries (including
 *    `packages`), and every pre-existing name-set file (decision 15), which the container can then not modify;
 *  - ro shadows: `rules` (push guard) and `app-server-daemon` (empty, D20);
 *  - rw shadows: `log`, `tmp`, `.tmp` and `shell_snapshots`; rw: `S/codex-sqlite`, at the same path as `CODEX_SQLITE_HOME` (D25).
 *
 * Only regular files are mounted over themselves: a symlink is the guard's business, never a mount source.
 */
export function codexMounts(paths: SandboxPaths, slug: string): { source: string; target: string; readonly: boolean }[] {
  const s = codexStatePaths(paths, slug)
  const h = (name: string): string => path.join(paths.codexDir, name)
  const mounts = [
    { source: paths.codexDir, target: paths.codexDir, readonly: false },
    { source: s.configOverlay, target: h('config.toml'), readonly: true },
    { source: s.env, target: h('.env'), readonly: true },
    ...HOST_READONLY_ENTRIES.map((name) => ({ source: h(name), target: h(name), readonly: true })),
    ...CODEX_SHADOWS.map((shadow) => ({ source: path.join(s.state, shadow.dir), target: h(shadow.name), readonly: shadow.readonly })),
    { source: s.sqlite, target: s.sqlite, readonly: false },
  ]
  // Defense in depth behind prepare: never hand a symlink or wrong-type entry to a mount (assertMountSafe also refuses it).
  const verified = verifyMountSources(paths.codexDir)
  if (!verified.ok) throw new Error(verified.detail)
  const taken = new Set(mounts.map((m) => m.target))
  for (const name of preexistingGuardedFiles(paths.codexDir)) {
    if (!taken.has(h(name))) mounts.push({ source: h(name), target: h(name), readonly: true })
  }
  return mounts
}

/**
 * Fail closed: every entry mounted read-only from the host, and every pre-existing guarded file, must be the right
 * type and not a symlink (SM-1). A planted or user-made symlink would be followed by the host's Codex and could
 * not be pinned read-only by a bind mount of the link itself.
 */
function verifyMountSources(home: string): AgentConfigResult {
  const check = (name: string, kind: Kind): AgentConfigResult => {
    const state = entryState(path.join(home, name), kind)
    return state === 'symlink' || state === 'wrong-type' ? invalid(problemDetail(`~/.codex/${name}`, state, kind)) : { ok: true }
  }
  for (const name of HOST_READONLY_ENTRIES) {
    const result = check(name, name === 'AGENTS.md' ? 'file' : 'dir')
    if (!result.ok) return result
  }
  let names: string[]
  try {
    names = fs.readdirSync(home).filter(inGuardNameSet)
  } catch {
    return { ok: true }
  }
  for (const name of names) {
    const result = check(name, 'file')
    if (!result.ok) return result
  }
  return { ok: true }
}

/**
 * On a case-insensitive filesystem (macOS APFS, an ext4 casefold dir) the container could write `CONFIG.TOML` or
 * `.ENV` through the read-write home and alias the read-only overlays. Probes with the case-swapped name of an entry
 * that was just created: the same inode means the home is case-insensitive.
 */
function homeIsCaseInsensitive(home: string): boolean {
  try {
    const real = fs.lstatSync(path.join(home, 'config.toml'))
    const swapped = fs.lstatSync(path.join(home, 'CONFIG.TOML'))
    return real.ino === swapped.ino && real.dev === swapped.dev
  } catch {
    return false
  }
}

/** The top-level regular files of `H` the guard watches (`AGENTS.override.md`, `hooks.json`, `x.config.toml`, `.env.*`) that already exist. */
function preexistingGuardedFiles(home: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(home)
  } catch {
    return []
  }
  return names.filter((name) => inGuardNameSet(name) && entryState(path.join(home, name), 'file') === 'ok').sort()
}

/** Removes the workspace's Codex state, without following a link. `codex-quarantine` is kept: "nothing was deleted" must stay true. */
export function clearCodexState(paths: SandboxPaths, slug: string, keepBaseline = false): void {
  const s = codexStatePaths(paths, slug)
  const targets = [s.configOverlay, s.env, s.sqlite, ...CODEX_SHADOWS.map((shadow) => path.join(s.state, shadow.dir))]
  if (!keepBaseline) targets.push(path.join(s.state, GUARD_BASELINE_FILE), path.join(s.state, GUARD_ACTIVE_FILE))
  for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true }) // rmSync removes a symlink itself and never descends through it
  }
}

/** Pure (lstat and one capped read, no writes): can Codex start in the sandbox? Codes key `descriptor.copy.readiness`. */
export function codexReadiness(paths: SandboxPaths): AgentReadiness {
  if (!homeIsRealDir(paths)) return { ok: false, code: 'never-run' }
  const store = authStore(paths)
  if (store !== null && store !== 'file') return { ok: false, code: 'keyring' }
  if (entryState(path.join(paths.codexDir, 'auth.json'), 'file') !== 'ok') return { ok: false, code: 'not-signed-in' }
  if (homeEntryBroken(paths)) return { ok: false, code: 'config-invalid' }
  return { ok: true }
}
