import { DockerError } from '../../main/services/docker-runner'
import type { DockerRunner, DockerResult, DockerRunOpts, DockerErrorKind, DockerErrorSubkind } from '../../main/services/docker-runner'

// ---------------------------------------------------------------------------
// fake-docker-runner.ts — a fake DockerRunner for unit tests that need
// sandbox-manager-adjacent code (steps 2.3+, 3.4+) without a real docker
// binary. No child_process, no real process spawned.
// ---------------------------------------------------------------------------

export interface FakeDockerRunnerCall {
  method: 'run' | 'stream'
  args: readonly string[]
  opts?: DockerRunOpts
}

export interface ScriptedError {
  kind: DockerErrorKind
  subkind?: DockerErrorSubkind
  exitCode?: number | null
  stderrTail?: string
}

export interface ScriptedOutcome {
  result?: DockerResult
  error?: ScriptedError
}

/**
 * Records every `run`/`stream` call and replays a scripted outcome keyed by
 * argv prefix: the MOST RECENTLY registered entry whose `prefix` matches the
 * call's leading args wins (so a later `.script()` call for the same prefix
 * overrides an earlier one — step 3.4's availability tests use this to
 * change a command's outcome partway through a test, e.g. daemon-down then
 * ok on the next call). Register more specific prefixes last if two could
 * otherwise both match the same call. A call with no matching entry
 * succeeds with an empty result — most tests only care about the one
 * command they're exercising.
 */
export class FakeDockerRunner implements DockerRunner {
  readonly calls: FakeDockerRunnerCall[] = []

  /** The fake models a local Docker Engine by default (SEC-M4's endpoint check); a test overrides it with `script(['context', 'inspect'], …)`. */
  private _script: Array<{ prefix: readonly string[]; outcome: ScriptedOutcome }> = [
    { prefix: ['context', 'inspect'], outcome: { result: { stdout: 'unix:///var/run/docker.sock\n', stderr: '', exitCode: 0 } } },
  ]
  private _binaryResult: ReturnType<DockerRunner['binary']> = { available: true, absPath: '/usr/bin/docker' }
  private _streamLines: string[] = []

  /** Registers a scripted outcome for the first call whose argv starts with `prefix`. */
  script(prefix: readonly string[], outcome: ScriptedOutcome): void {
    this._script.push({ prefix, outcome })
  }

  /** Controls what `binary()` returns — defaults to an available fake docker. */
  setBinary(result: ReturnType<DockerRunner['binary']>): void {
    this._binaryResult = result
  }

  /** Lines `stream()` replays to `onLine`, in order, before settling. */
  setStreamLines(lines: readonly string[]): void {
    this._streamLines = [...lines]
  }

  binary(): ReturnType<DockerRunner['binary']> {
    return this._binaryResult
  }

  async run(args: readonly string[], opts?: DockerRunOpts): Promise<DockerResult> {
    this.calls.push({ method: 'run', args, opts })
    return this._settle(args)
  }

  async stream(args: readonly string[], onLine: (line: string) => void, signal: AbortSignal): Promise<DockerResult> {
    this.calls.push({ method: 'stream', args })
    for (const line of this._streamLines) onLine(line)
    if (signal.aborted) {
      throw new DockerError('failed', { exitCode: null, stderrTail: '' })
    }
    return this._settle(args)
  }

  private _settle(args: readonly string[]): DockerResult {
    // `findLast` needs an ES2023 lib target this project doesn't set — walk
    // backwards instead, which is the same "most recently registered wins" semantics.
    let entry: (typeof this._script)[number] | undefined
    for (let i = this._script.length - 1; i >= 0; i--) {
      if (this._script[i].prefix.every((p, j) => args[j] === p)) {
        entry = this._script[i]
        break
      }
    }
    if (!entry) return { stdout: '', stderr: '', exitCode: 0 }

    if (entry.outcome.error) {
      const e = entry.outcome.error
      throw new DockerError(e.kind, { subkind: e.subkind, exitCode: e.exitCode ?? null, stderrTail: e.stderrTail ?? '' })
    }
    return entry.outcome.result ?? { stdout: '', stderr: '', exitCode: 0 }
  }
}
