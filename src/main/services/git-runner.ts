import { execFile } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ---------------------------------------------------------------------------
// git-runner.ts — the ONLY file allowed to import child_process (Sec M-9;
// enforced by the eslint.config.mjs `no-restricted-imports` /
// `no-restricted-syntax` rules, see eslint-child-process.test.ts).
//
// Hardened git execution (TRD §3.3.2, §10.4): absolute-binary resolution
// that refuses a repo-planted `git` (M4), a locked-down environment (C1,
// L8, L9), bounded concurrency with single-flight dedup, and sanitized
// output/errors. This module is the first and only place git is spawned;
// git-service.ts (step 1.11+) builds repository operations on top of it.
// ---------------------------------------------------------------------------

// A repo-relative execution context. `workspaceRoots` is the CURRENT list of
// known workspace roots (absolute, as discovered by the app) and is supplied
// fresh on every call — not cached — so a workspace added after git was
// first resolved is still caught by the re-check below (Sec M-8).
export interface RepoCtx {
  /** Absolute repository root. Used as execFile's cwd, for GIT_CEILING_DIRECTORIES,
   *  and as the key for the semaphore, single-flight and abortRoot. */
  root: string
  /** Every known workspace root, absolute. Not necessarily realpath'd by the
   *  caller — this module realpaths both sides before comparing. */
  workspaceRoots: readonly string[]
}

export interface GitRunOpts {
  timeoutMs?: number
  maxBuffer?: number
  stdin?: Buffer
  /** Exit codes treated as success in addition to 0 (e.g. check-ignore's 1). */
  allowExit?: number[]
  /** Documents that this call runs filters/textconv (the status/diff pair) —
   *  informational for callers; the actual per-call driver enumeration and
   *  neutralization is git-service.ts's job (step 1.12, M1). */
  filterCapable?: boolean
  /** `filter.<d>.*` / `diff.<d>.*` neutralization entries computed by the
   *  caller for a filter-capable command, applied via GIT_CONFIG_COUNT
   *  (driver names are repo-controlled and may contain '=', so the env
   *  mechanism is used rather than `-c`). */
  driverNulls?: Record<string, string>
}

export interface GitRunResult {
  stdout: Buffer
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024 // 16 MB (H3 budget)
const MAX_STDERR_LOG_BYTES = 2 * 1024
const SEMAPHORE_LIMIT = 4

// Case-insensitive URL userinfo redaction for logged stderr (Sec L-1, L4).
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi

/**
 * Kill switch (L8, §8.2 rollback lever). A real rollback flips this constant
 * in source and ships a patch; tests flip it directly to exercise the path.
 * When set, every git call (probe, status, blob, index, check-ignore) throws
 * GitDisabled and the explorer reports `git-unavailable`.
 */
export const gitRunnerSettings = { executionDisabled: false }

export class GitDisabled extends Error {
  constructor() {
    super('Git execution is disabled')
    this.name = 'GitDisabled'
  }
}

function isInsideAnyRoot(absPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => absPath === root || absPath.startsWith(root + path.sep))
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

export type ResolvedGit =
  | { available: true; absPath: string }
  | { available: false; reason: 'not-found' | 'inside-workspace' }

/**
 * Resolve the absolute git binary from PATH (M4): walk `pathEnv`, skipping
 * empty, `.` and relative entries (each of those historically means, or can
 * be tricked into meaning, "the current directory" — the repo itself).
 * Take the first `git` (`git.exe` on win32) that is a regular executable
 * file, realpath it, and refuse it if that realpath lies inside any of
 * `workspaceRoots` (also realpath'd before comparison).
 */
export function resolveGitBinary(
  pathEnv: string | undefined,
  workspaceRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ResolvedGit {
  const binaryName = platform === 'win32' ? 'git.exe' : 'git'
  const realRoots = workspaceRoots.map(realpathOrNull).filter((r): r is string => r !== null)
  const entries = (pathEnv ?? '').split(path.delimiter)

  for (const rawEntry of entries) {
    if (!rawEntry) continue // empty PATH entry (historically "cwd") — skip
    if (rawEntry === '.') continue
    if (!path.isAbsolute(rawEntry)) continue // relative entries — skip

    const candidate = path.join(rawEntry, binaryName)
    let st: fs.Stats
    try {
      st = fs.statSync(candidate)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (platform !== 'win32' && (st.mode & 0o111) === 0) continue // not executable

    const real = realpathOrNull(candidate)
    if (real === null) continue

    if (isInsideAnyRoot(real, realRoots)) {
      return { available: false, reason: 'inside-workspace' }
    }
    return { available: true, absPath: real }
  }
  return { available: false, reason: 'not-found' }
}

/**
 * The env recipe (order matters, TRD §3.3.2):
 *  1. Strip every GIT_* key from `base`.
 *  2. Apply `overrides` (test-only; production passes none).
 *  3. Always set the security variables — they win over anything above,
 *     including `overrides`, so a hostile override can never weaken them.
 *     GIT_CONFIG_COUNT is always set, to 0 when `driverNulls` is empty
 *     (Sec L-2), so a smuggled GIT_CONFIG_KEY_0 from `overrides` or `base`
 *     is ignored (it sits above an explicit count of 0).
 */
export function buildEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> | undefined,
  driverNulls: Record<string, string> | undefined,
  root: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('GIT_')) continue
    if (value !== undefined) env[key] = value
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }

  env.GIT_ALLOW_PROTOCOL = '' // (C1) — outranks every protocol.<name>.allow
  env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_OPTIONAL_LOCKS = '0' // the real control for post-index-change (L9)
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CEILING_DIRECTORIES = path.dirname(root)
  env.LC_ALL = 'C'

  const nullEntries = Object.entries(driverNulls ?? {})
  env.GIT_CONFIG_COUNT = String(nullEntries.length)
  nullEntries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })

  return env
}

const INVARIANT_PREFIX = [
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'safe.bareRepository=explicit',
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'diff.external=',
  '-c', 'log.showSignature=false',
  '-c', 'protocol.allow=never', // third layer only — NOT sufficient alone (C1)
  '-c', 'core.quotePath=false',
]

export interface GitVersion {
  major: number
  minor: number
  patch: number
  raw: string
}

export type GitVersionState =
  | { state: 'ok'; version: GitVersion; preFix: boolean } // preFix: below 2.39.1 (M5, info only)
  | { state: 'too-old'; version: GitVersion }
  | { state: 'unavailable' }

const MIN_VERSION: readonly [number, number, number] = [2, 31, 0]
const CVE_FIX_VERSION: readonly [number, number, number] = [2, 39, 1]

function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** Parses `git version X.Y.Z...` output (distro suffixes like `.windows.1`
 * or `.github` are ignored — only the leading three numeric components
 * matter for the floor and CVE-fix comparisons). */
export function parseGitVersion(raw: string): GitVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: raw.trim() }
}

/** Redact URL userinfo (`scheme://user:pass@`) case-insensitively (Sec L-1, L4). */
export function redactUrlUserinfo(text: string): string {
  return text.replace(USERINFO_RE, '$1***@')
}

function formatStderrForLog(stderr: Buffer): string {
  // Redact BEFORE truncating: truncating first could cut a credential in
  // half right at the boundary, leaving an unredacted fragment in the log.
  const redacted = redactUrlUserinfo(stderr.toString('utf-8'))
  return redacted.slice(0, MAX_STDERR_LOG_BYTES)
}

/** Keep only complete NUL-terminated records: everything up to and including
 *  the last NUL, dropping a trailing partial record. */
function truncateAtLastNul(buf: Buffer): Buffer {
  const idx = buf.lastIndexOf(0)
  return idx === -1 ? Buffer.alloc(0) : buf.subarray(0, idx + 1)
}

function hashKeyParts(parts: readonly string[]): string {
  const hash = crypto.createHash('sha256')
  for (const part of parts) hash.update(part).update('\u0000')
  return hash.digest('hex')
}

function createSemaphore(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const grant = () => {
          active++
          resolve(() => {
            active--
            const next = queue.shift()
            if (next) next()
          })
        }
        if (active < limit) grant()
        else queue.push(grant)
      })
    },
  }
}

export interface CreateGitServiceOptions {
  /** Test-only environment overrides, applied after the GIT_* strip and
   *  before the security variables so hardening always wins (§7.2 H1). */
  baseEnvOverrides?: Record<string, string | undefined>
  /** True in a packaged production build. Throws if `baseEnvOverrides` is
   *  also given (Sec L-4) — hermetic overrides must never reach a real build. */
  isPackaged?: boolean
}

export interface GitService {
  runGit(ctx: RepoCtx, args: readonly string[], opts?: GitRunOpts): Promise<GitRunResult>
  /** Kills every in-flight child for `root` and frees its semaphore slots.
   *  A grandchild process (e.g. a global LFS filter) can outlive SIGKILL —
   *  accepted (Sec L-9). */
  abortRoot(root: string): void
  /** `git --version`, run once and cached for the life of the service. */
  getVersion(): Promise<GitVersionState>
}

/** Internal: run the resolved git binary with no single-flight/semaphore/env
 * policy — used only for the one-off, repo-independent `--version` probe. */
function execRaw(
  absGit: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number },
): Promise<{ stdout: Buffer; stderr: Buffer; error: (NodeJS.ErrnoException & { code?: number | string }) | null }> {
  return new Promise((resolve) => {
    execFile(
      absGit,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        windowsHide: true,
        maxBuffer: opts.maxBuffer,
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? Buffer.alloc(0), stderr: stderr ?? Buffer.alloc(0), error: error as NodeJS.ErrnoException | null })
      },
    )
  })
}

export function createGitService(options: CreateGitServiceOptions = {}): GitService {
  const { baseEnvOverrides, isPackaged = false } = options
  if (baseEnvOverrides && isPackaged) {
    throw new Error('baseEnvOverrides must not be used in a packaged build')
  }

  let cachedGit: ResolvedGit | null = null
  let cachedVersion: GitVersionState | null = null
  // One semaphore for the whole service (TRD §9.3: "Git concurrency: 4" is an
  // app-wide cap on concurrent git children, not a per-root allowance — the
  // "(per-root abort on switch)" note describes abortRoot's scope, not the
  // concurrency cap's). abortRoot still only cancels the calls for its root;
  // that just happens to free whichever of the shared 4 slots those calls held.
  const semaphore = createSemaphore(SEMAPHORE_LIMIT)
  const inFlight = new Map<string, Promise<GitRunResult>>()
  const controllersByRoot = new Map<string, Set<AbortController>>()

  function trackController(root: string, controller: AbortController): () => void {
    let set = controllersByRoot.get(root)
    if (!set) {
      set = new Set()
      controllersByRoot.set(root, set)
    }
    set.add(controller)
    return () => {
      set!.delete(controller)
      if (set!.size === 0) controllersByRoot.delete(root)
    }
  }

  function resolveGit(ctx: RepoCtx): ResolvedGit {
    if (!cachedGit) {
      cachedGit = resolveGitBinary(process.env.PATH, ctx.workspaceRoots)
      return cachedGit
    }
    // Re-check on every call: a workspace discovered after the first
    // resolution must still catch a git binary that now lies inside it
    // (Sec M-8).
    if (cachedGit.available && isInsideAnyRoot(cachedGit.absPath, ctx.workspaceRoots.map(realpathOrNull).filter((r): r is string => r !== null))) {
      cachedGit = { available: false, reason: 'inside-workspace' }
    }
    return cachedGit
  }

  async function runGitOnce(
    absGit: string,
    ctx: RepoCtx,
    args: readonly string[],
    opts: GitRunOpts,
  ): Promise<GitRunResult> {
    const release = await semaphore.acquire()
    const controller = new AbortController()
    const untrack = trackController(ctx.root, controller)
    let timedOut = false
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      const env = buildEnv(process.env, baseEnvOverrides, opts.driverNulls, ctx.root)
      const finalArgs = [...INVARIANT_PREFIX, ...args]
      const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER

      const result = await new Promise<GitRunResult>((resolve, reject) => {
        const child = execFile(
          absGit,
          finalArgs,
          {
            cwd: ctx.root,
            env,
            shell: false,
            windowsHide: true,
            maxBuffer,
            signal: controller.signal,
            killSignal: 'SIGKILL',
            encoding: 'buffer',
          },
          (error, stdout, stderr) => {
            const stdoutBuf = (stdout as unknown as Buffer) ?? Buffer.alloc(0)
            const stderrBuf = (stderr as unknown as Buffer) ?? Buffer.alloc(0)
            const redactedStderr = stderrBuf.length > 0 ? formatStderrForLog(stderrBuf) : ''

            if (redactedStderr) {
              console.warn(`[git-runner] stderr: ${redactedStderr}`)
            }

            if (error) {
              const err = error as NodeJS.ErrnoException & { code?: number | string }
              if (timedOut) {
                reject(Object.assign(new Error('Git operation timed out'), { code: 'TIMEOUT' }))
                return
              }
              if (controller.signal.aborted) {
                reject(Object.assign(new Error('Git operation aborted'), { code: 'INTERNAL_ERROR' }))
                return
              }
              if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                resolve({ stdout: truncateAtLastNul(stdoutBuf), truncated: true })
                return
              }
              if (typeof err.code === 'number' && (opts.allowExit ?? []).includes(err.code)) {
                resolve({ stdout: stdoutBuf, truncated: false })
                return
              }
              // stderr is already redacted/capped (same text just logged above)
              // — never raw — so a caller classifying a known git error (e.g.
              // "dubious ownership", git-service.ts step 1.11) can't leak a
              // credential fragment through this internal channel either.
              reject(
                Object.assign(new Error('Git command failed'), {
                  code: 'INTERNAL_ERROR',
                  gitExitCode: err.code,
                  stderr: redactedStderr,
                }),
              )
              return
            }

            resolve({ stdout: stdoutBuf, truncated: false })
          },
        )

        if (opts.stdin) child.stdin?.end(opts.stdin)
        else child.stdin?.end()
      })

      return result
    } finally {
      clearTimeout(timer)
      untrack()
      release()
    }
  }

  return {
    // Deliberately NOT declared `async`: the single-flight dedup path below
    // must return the exact same Promise reference to every caller sharing
    // a key, not a fresh Promise adopting its value (which an `async`
    // function's implicit wrapping would produce). Failure paths return
    // Promise.reject(...) explicitly so callers still get a rejected
    // Promise rather than a synchronous throw.
    runGit(ctx: RepoCtx, args: readonly string[], opts: GitRunOpts = {}): Promise<GitRunResult> {
      if (gitRunnerSettings.executionDisabled) return Promise.reject(new GitDisabled())

      const resolved = resolveGit(ctx)
      if (!resolved.available) {
        return Promise.reject(
          Object.assign(new Error('git is not available'), { code: 'INTERNAL_ERROR', reason: resolved.reason }),
        )
      }

      const stdinHash = opts.stdin ? crypto.createHash('sha256').update(opts.stdin).digest('hex') : ''
      const driverHash = hashKeyParts(
        Object.entries(opts.driverNulls ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`),
      )
      const key = hashKeyParts([ctx.root, ...args, driverHash, stdinHash])

      const existing = inFlight.get(key)
      if (existing) return existing

      const promise = runGitOnce(resolved.absPath, ctx, args, opts).finally(() => {
        inFlight.delete(key)
      })
      inFlight.set(key, promise)
      return promise
    },

    abortRoot(root: string): void {
      const set = controllersByRoot.get(root)
      if (!set) return
      for (const controller of Array.from(set)) controller.abort()
    },

    async getVersion(): Promise<GitVersionState> {
      if (cachedVersion) return cachedVersion
      // Version-checking is repo-independent; cwd doesn't matter, so a
      // neutral tmp directory is used rather than threading a RepoCtx through.
      const resolved = resolveGitBinary(process.env.PATH, [])
      if (!resolved.available) {
        cachedVersion = { state: 'unavailable' }
        return cachedVersion
      }
      const env = buildEnv(process.env, baseEnvOverrides, undefined, os.tmpdir())
      const { stdout, error } = await execRaw(resolved.absPath, ['--version'], {
        cwd: os.tmpdir(),
        env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
      })
      if (error) {
        cachedVersion = { state: 'unavailable' }
        return cachedVersion
      }
      const version = parseGitVersion(stdout.toString('utf-8'))
      if (!version) {
        cachedVersion = { state: 'unavailable' }
        return cachedVersion
      }
      const tuple: [number, number, number] = [version.major, version.minor, version.patch]
      if (compareVersions(tuple, MIN_VERSION) < 0) {
        cachedVersion = { state: 'too-old', version }
        return cachedVersion
      }
      cachedVersion = { state: 'ok', version, preFix: compareVersions(tuple, CVE_FIX_VERSION) < 0 }
      return cachedVersion
    },
  }
}
