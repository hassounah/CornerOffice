import { execFile, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { resolveExecutable } from './git-runner'
import type { ResolvedExecutable } from './git-runner'
import { sanitizedEnv } from './env-policy'

// ---------------------------------------------------------------------------
// docker-runner.ts — the second sanctioned `child_process` module (Sec M-9;
// enforced by the eslint.config.mjs `no-restricted-imports` /
// `no-restricted-syntax` rules, see eslint-child-process.test.ts). Mirrors
// git-runner.ts's hardening (absolute-binary resolution that refuses a
// planted `docker`, a locked-down environment, sanitized errors) for the
// docker CLI (TRD §3.3). sandbox-manager.ts (steps 3.4+) builds container
// operations on top of this; it never imports child_process itself.
// ---------------------------------------------------------------------------

export interface DockerResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type DockerErrorKind = 'not-installed' | 'daemon-down' | 'no-permission' | 'timeout' | 'failed'

/** A `failed`-kind error the manager reads for a more specific reason (Appendix C item 20). */
export type DockerErrorSubkind = 'port-conflict' | 'no-such-container'

export class DockerError extends Error {
  kind: DockerErrorKind
  subkind?: DockerErrorSubkind
  exitCode: number | null
  /** Redaction-free (docker output has no credentials to leak), but still capped at 2 KB for logs. */
  stderrTail: string

  constructor(kind: DockerErrorKind, opts: { subkind?: DockerErrorSubkind; exitCode: number | null; stderrTail: string }) {
    super(`Docker command failed: ${kind}${opts.subkind ? ` (${opts.subkind})` : ''}`)
    this.name = 'DockerError'
    this.kind = kind
    this.subkind = opts.subkind
    this.exitCode = opts.exitCode
    this.stderrTail = opts.stderrTail
  }
}

export interface DockerRunOpts {
  timeoutMs?: number
  maxBuffer?: number
  stdin?: string
  /** Exit codes treated as success in addition to 0. */
  allowExit?: number[]
}

export interface DockerRunner {
  /** Absolute docker path — resolved once, re-checked against `refusalRoots()` on every call (M4, L5). */
  binary(): ResolvedExecutable
  run(args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult>
  /** No timeout — a build can run indefinitely; cancel it via `signal`. */
  stream(args: readonly string[], onLine: (line: string) => void, signal: AbortSignal): Promise<DockerResult>
}

export interface CreateDockerRunnerDeps {
  /** Workspace roots plus every read-write mount source (L5) — recomputed on every call, never cached by the caller. */
  refusalRoots: () => string[]
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024
const MAX_STDERR_LOG_BYTES = 2 * 1024

/** Host env vars that pass through to the docker CLI process unchanged (not the container — that gets only explicit `-e` flags). */
const PASSTHROUGH_ENV_KEYS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'] as const

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

/** stderr regex classification (§3.3). Order matters: the first match wins. */
function classifyError(stderr: string): { kind: DockerErrorKind; subkind?: DockerErrorSubkind } {
  if (/permission denied.*docker\.sock/i.test(stderr)) return { kind: 'no-permission' }
  if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(stderr)) return { kind: 'daemon-down' }
  if (/port is already allocated|address already in use/i.test(stderr)) return { kind: 'failed', subkind: 'port-conflict' }
  if (/No such container/i.test(stderr)) return { kind: 'failed', subkind: 'no-such-container' }
  return { kind: 'failed' }
}

function truncateStderr(stderr: string): string {
  return stderr.slice(0, MAX_STDERR_LOG_BYTES)
}

/** One log-safe line for a failed docker call: kind, subkind, exit code and the stderr tail (already capped at 2 KB; docker stderr carries no credentials). Never pass raw stdout such as inspect JSON here. */
export function describeDockerError(err: DockerError): string {
  const parts = [`kind=${err.kind}`]
  if (err.subkind) parts.push(`subkind=${err.subkind}`)
  parts.push(`exit=${err.exitCode === null ? 'none' : String(err.exitCode)}`)
  parts.push(`stderr=${JSON.stringify(truncateStderr(err.stderrTail))}`)
  return parts.join(' ')
}

export function createDockerRunner(deps: CreateDockerRunnerDeps): DockerRunner {
  let cached: ResolvedExecutable | null = null

  function binary(): ResolvedExecutable {
    const roots = deps.refusalRoots()
    if (!cached) {
      cached = resolveExecutable('docker', process.env.PATH, roots, process.platform)
      return cached
    }
    // Re-check on every call: a workspace or rw mount source discovered
    // after the first resolution must still catch a docker binary that now
    // lies inside it (Sec M-8, mirrors git-runner.ts).
    if (cached.available) {
      const realRoots = roots.map(realpathOrNull).filter((r): r is string => r !== null)
      if (isInsideAnyRoot(cached.absPath, realRoots)) {
        cached = { available: false, reason: 'inside-workspace' }
      }
    }
    return cached
  }

  /** `process.env` minus `ENV_DENYLIST`, plus `LC_ALL=C`. Passthrough keys survive `sanitizedEnv` untouched since they're not on the denylist — listed here only for clarity. */
  function buildEnv(): NodeJS.ProcessEnv {
    const env = sanitizedEnv(process.env)
    env.LC_ALL = 'C'
    for (const key of PASSTHROUGH_ENV_KEYS) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    return env
  }

  return {
    binary,

    run(args, opts = {}) {
      const resolved = binary()
      if (!resolved.available) {
        return Promise.reject(new DockerError('not-installed', { exitCode: null, stderrTail: '' }))
      }
      const absDocker = resolved.absPath

      return new Promise<DockerResult>((resolve, reject) => {
        const child = execFile(
          absDocker,
          [...args],
          {
            shell: false,
            windowsHide: true,
            timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
            killSignal: 'SIGKILL',
            env: buildEnv(),
            encoding: 'utf-8',
          },
          (error, stdout, stderr) => {
            const stdoutStr = stdout.toString()
            const stderrStr = stderr.toString()
            const stderrTail = truncateStderr(stderrStr)

            if (!error) {
              resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 })
              return
            }

            const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: NodeJS.Signals | null }

            if (err.code === 'ENOENT') {
              reject(new DockerError('not-installed', { exitCode: null, stderrTail }))
              return
            }
            if (typeof err.code === 'number' && (opts.allowExit ?? []).includes(err.code)) {
              resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: err.code })
              return
            }
            // The `timeout` option kills the child with `killSignal` ('SIGKILL')
            // when it fires — the only thing in this code path that sends that
            // signal, so this reliably means the timeout elapsed.
            if (err.killed && err.signal === 'SIGKILL' && typeof err.code !== 'number') {
              reject(new DockerError('timeout', { exitCode: null, stderrTail }))
              return
            }

            const { kind, subkind } = classifyError(stderrStr)
            reject(new DockerError(kind, { subkind, exitCode: typeof err.code === 'number' ? err.code : null, stderrTail }))
          },
        )

        if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
        else child.stdin?.end()
      })
    },

    stream(args, onLine, signal) {
      const resolved = binary()
      if (!resolved.available) {
        return Promise.reject(new DockerError('not-installed', { exitCode: null, stderrTail: '' }))
      }
      const absDocker = resolved.absPath

      return new Promise<DockerResult>((resolve, reject) => {
        const child = spawn(absDocker, [...args], {
          shell: false,
          windowsHide: true,
          env: buildEnv(),
          signal,
          killSignal: 'SIGKILL',
        })

        let stdoutAll = ''
        let stderrAll = ''
        let stdoutPartial = ''
        let stderrPartial = ''

        const consume = (chunk: Buffer, isStderr: boolean): void => {
          const text = chunk.toString('utf-8')
          if (isStderr) stderrAll += text
          else stdoutAll += text

          let partial = (isStderr ? stderrPartial : stdoutPartial) + text
          const lines = partial.split('\n')
          partial = lines.pop() ?? ''
          if (isStderr) stderrPartial = partial
          else stdoutPartial = partial
          for (const line of lines) onLine(line)
        }

        child.stdout?.on('data', (chunk: Buffer) => consume(chunk, false))
        child.stderr?.on('data', (chunk: Buffer) => consume(chunk, true))

        child.on('error', (error) => {
          const err = error as NodeJS.ErrnoException
          const stderrTail = truncateStderr(stderrAll)
          if (err.code === 'ENOENT') {
            reject(new DockerError('not-installed', { exitCode: null, stderrTail }))
            return
          }
          const { kind, subkind } = classifyError(stderrAll)
          reject(new DockerError(kind, { subkind, exitCode: null, stderrTail }))
        })

        child.on('close', (code) => {
          if (stdoutPartial) onLine(stdoutPartial)
          if (stderrPartial) onLine(stderrPartial)
          const stderrTail = truncateStderr(stderrAll)

          if (signal.aborted) {
            reject(new DockerError('failed', { exitCode: code, stderrTail }))
            return
          }
          if (code === 0) {
            resolve({ stdout: stdoutAll, stderr: stderrAll, exitCode: 0 })
            return
          }
          const { kind, subkind } = classifyError(stderrAll)
          reject(new DockerError(kind, { subkind, exitCode: code, stderrTail }))
        })
      })
    },
  }
}
