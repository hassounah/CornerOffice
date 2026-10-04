import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ---------------------------------------------------------------------------
// docker-runner.test.ts (TRD §3.3, Sec M-9, L5)
// ---------------------------------------------------------------------------
// child_process is mocked (both the named exports and `default`, matching
// this project's Vitest/ESM interop — a mock missing `default` lets the
// real execFile/spawn run unintercepted, confirmed empirically). fs is real:
// binary() resolution uses the same fake-binary-on-PATH technique as
// git-runner.test.ts, which already exhaustively covers resolveExecutable
// itself (step 1.2) — this file only needs to prove createDockerRunner
// wires it up correctly.
// ---------------------------------------------------------------------------

const execFileMock = vi.hoisted(() => vi.fn())
const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
  default: { execFile: execFileMock, spawn: spawnMock },
}))

import { createDockerRunner, describeDockerError, DockerError } from '../main/services/docker-runner'
import { FakeDockerRunner } from './helpers/fake-docker-runner'

// execFile's real error.code can be a number (exit code) or a string ('ENOENT'
// etc.) — narrower than NodeJS.ErrnoException's `code?: string`, matching how
// docker-runner.ts itself reads it (`code?: number | string`).
type ExecFileError = Omit<NodeJS.ErrnoException, 'code'> & { code?: number | string; killed?: boolean }
type ExecFileCallback = (error: ExecFileError | null, stdout: string, stderr: string) => void

function makeExecutable(dir: string, name: string, contents = '#!/bin/sh\nexit 0\n'): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, contents)
  fs.chmodSync(p, 0o755)
  return p
}

/** Configures execFileMock to invoke its callback with a scripted result, and returns a stdin-stub child (docker-runner.ts always calls `child.stdin?.end(...)`). */
function respondWith(error: ExecFileError | null, stdout: string, stderr: string) {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
    cb(error, stdout, stderr)
    return { stdin: { end: vi.fn() } }
  })
}

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

let tmpDir: string
let originalPath: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-docker-runner-test-'))
  originalPath = process.env.PATH
})

afterEach(() => {
  process.env.PATH = originalPath
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── binary() ─────────────────────────────────────────────────────────────

describe('binary()', () => {
  it('resolves the docker binary from PATH', () => {
    const binDir = path.join(tmpDir, 'bin')
    const dockerPath = makeExecutable(binDir, 'docker')
    process.env.PATH = binDir

    const runner = createDockerRunner({ refusalRoots: () => [] })
    expect(runner.binary()).toEqual({ available: true, absPath: fs.realpathSync(dockerPath) })
  })

  it('refuses a docker binary inside a refusal root (L5)', () => {
    const binDir = path.join(tmpDir, 'workspace', 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir

    const runner = createDockerRunner({ refusalRoots: () => [path.join(tmpDir, 'workspace')] })
    expect(runner.binary()).toEqual({ available: false, reason: 'inside-workspace' })
  })

  it('reports not-found when docker is not on PATH', () => {
    process.env.PATH = tmpDir // empty dir, no docker
    const runner = createDockerRunner({ refusalRoots: () => [] })
    expect(runner.binary()).toEqual({ available: false, reason: 'not-found' })
  })

  it('caches the resolution, but re-checks refusal roots on every call (Sec M-8)', () => {
    const binDir = path.join(tmpDir, 'bin')
    const dockerPath = makeExecutable(binDir, 'docker')
    process.env.PATH = binDir

    let roots: string[] = []
    const runner = createDockerRunner({ refusalRoots: () => roots })

    expect(runner.binary()).toEqual({ available: true, absPath: fs.realpathSync(dockerPath) })

    // A root added after the first resolution still catches the cached binary.
    roots = [binDir]
    expect(runner.binary()).toEqual({ available: false, reason: 'inside-workspace' })
  })

  it('tolerates a refusal root that does not exist on disk (no crash on the re-check)', () => {
    const binDir = path.join(tmpDir, 'bin')
    const dockerPath = makeExecutable(binDir, 'docker')
    process.env.PATH = binDir

    const runner = createDockerRunner({ refusalRoots: () => [path.join(tmpDir, 'does-not-exist')] })
    expect(runner.binary()).toEqual({ available: true, absPath: fs.realpathSync(dockerPath) })
    // Second call exercises the re-check path against the same nonexistent root.
    expect(runner.binary()).toEqual({ available: true, absPath: fs.realpathSync(dockerPath) })
  })
})

// ── run() ────────────────────────────────────────────────────────────────

describe('run()', () => {
  it('resolves with stdout/stderr/exitCode 0 on success', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(null, 'out', '')

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const result = await runner.run(['version'])
    expect(result).toEqual({ stdout: 'out', stderr: '', exitCode: 0 })
  })

  it('calls execFile with shell:false, windowsHide, killSignal SIGKILL and the exact argv array', async () => {
    const binDir = path.join(tmpDir, 'bin')
    const dockerPath = makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(null, '', '')

    const runner = createDockerRunner({ refusalRoots: () => [] })
    await runner.run(['ps', '--all'])

    expect(execFileMock).toHaveBeenCalledWith(
      fs.realpathSync(dockerPath),
      ['ps', '--all'],
      expect.objectContaining({ shell: false, windowsHide: true, killSignal: 'SIGKILL' }),
      expect.any(Function),
    )
  })

  it('rejects with not-installed without calling execFile when the binary is unavailable', async () => {
    process.env.PATH = tmpDir
    const runner = createDockerRunner({ refusalRoots: () => [] })
    await expect(runner.run(['version'])).rejects.toMatchObject({ kind: 'not-installed' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('removes denylisted env keys, sets LC_ALL=C, and keeps DOCKER_HOST', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    respondWith(null, '', '')

    const savedEnv = process.env
    process.env = { ...savedEnv, PATH: binDir, AWS_SECRET_ACCESS_KEY: 'secret', DOCKER_HOST: 'tcp://localhost:1234' }
    try {
      const runner = createDockerRunner({ refusalRoots: () => [] })
      await runner.run(['ps'])
      const passedEnv = execFileMock.mock.calls[0][2].env as Record<string, string>
      expect(passedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(passedEnv.DOCKER_HOST).toBe('tcp://localhost:1234')
      expect(passedEnv.LC_ALL).toBe('C')
    } finally {
      process.env = savedEnv
    }
  })

  it('classifies ENOENT as not-installed', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', '')

    const runner = createDockerRunner({ refusalRoots: () => [] })
    await expect(runner.run(['version'])).rejects.toMatchObject({ kind: 'not-installed' })
  })

  it.each([
    ['permission denied while trying to connect to the docker.sock', 'no-permission', undefined],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'daemon-down', undefined],
    ['Bind for 0.0.0.0:20001 failed: port is already allocated.', 'failed', 'port-conflict'],
    ['Error: No such container: co-sandbox-my-ws', 'failed', 'no-such-container'],
    ['error: no such object: co-sandbox-my-ws', 'failed', 'no-such-container'],
    ['some other docker error', 'failed', undefined],
  ])('classifies stderr %j as kind=%s subkind=%s', async (stderr, kind, subkind) => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(Object.assign(new Error('failed'), { code: 1 }), '', stderr)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    await expect(runner.run(['x'])).rejects.toMatchObject({ kind, subkind, exitCode: 1 })
  })

  it('truncates stderrTail to 2KB', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(Object.assign(new Error('failed'), { code: 1 }), '', 'x'.repeat(5000))

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const err: DockerError = await runner.run(['x']).catch((e) => e)
    expect(err.stderrTail.length).toBe(2048)
  })

  it('sets exitCode to null when the error carries no numeric code', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(Object.assign(new Error('some other docker error'), {}), '', 'some other docker error')

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const err: DockerError = await runner.run(['x']).catch((e) => e)
    expect(err.exitCode).toBeNull()
  })

  it('classifies a timeout kill (killSignal SIGKILL, no exit code) as timeout', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), '', '')

    const runner = createDockerRunner({ refusalRoots: () => [] })
    await expect(runner.run(['x'])).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('resolves (not rejects) when the exit code is in allowExit', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    respondWith(Object.assign(new Error('exit 1'), { code: 1 }), 'partial', '')

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const result = await runner.run(['x'], { allowExit: [1] })
    expect(result).toEqual({ stdout: 'partial', stderr: '', exitCode: 1 })
  })

  it('writes stdin when provided', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const stdinEnd = vi.fn()
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, '', '')
      return { stdin: { end: stdinEnd } }
    })

    const runner = createDockerRunner({ refusalRoots: () => [] })
    await runner.run(['exec', '-i', 'c', 'init-firewall.sh', 'allowlist'], { stdin: 'example.com\n' })
    expect(stdinEnd).toHaveBeenCalledWith('example.com\n')
  })
})

// ── stream() ─────────────────────────────────────────────────────────────

describe('stream()', () => {
  it('spawns with shell:false, windowsHide, killSignal SIGKILL and the AbortSignal wired through (Node performs the actual kill on abort)', async () => {
    const binDir = path.join(tmpDir, 'bin')
    const dockerPath = makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const controller = new AbortController()
    const resultPromise = runner.stream(['build', '.'], () => {}, controller.signal)
    child.emit('close', 0)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      fs.realpathSync(dockerPath),
      ['build', '.'],
      expect.objectContaining({ shell: false, windowsHide: true, signal: controller.signal, killSignal: 'SIGKILL' }),
    )
  })

  it('rejects with not-installed without calling spawn when the binary is unavailable', async () => {
    process.env.PATH = tmpDir
    const runner = createDockerRunner({ refusalRoots: () => [] })
    await expect(runner.stream(['build', '.'], () => {}, new AbortController().signal)).rejects.toMatchObject({
      kind: 'not-installed',
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('splits stdout into lines via onLine, holding back a partial trailing line until close', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const lines: string[] = []
    const resultPromise = runner.stream(['build', '.'], (l) => lines.push(l), new AbortController().signal)

    child.stdout.emit('data', Buffer.from('line1\nline2\npart'))
    expect(lines).toEqual(['line1', 'line2'])

    child.emit('close', 0)
    await resultPromise
    expect(lines).toEqual(['line1', 'line2', 'part'])
  })

  it('resolves with the accumulated stdout/stderr on a clean exit', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const resultPromise = runner.stream(['build', '.'], () => {}, new AbortController().signal)
    child.stdout.emit('data', Buffer.from('building\n'))
    child.emit('close', 0)

    await expect(resultPromise).resolves.toEqual({ stdout: 'building\n', stderr: '', exitCode: 0 })
  })

  it('rejects, classified via stderr, on a non-zero exit', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const resultPromise = runner.stream(['build', '.'], () => {}, new AbortController().signal)
    child.stderr.emit('data', Buffer.from('Cannot connect to the Docker daemon\n'))
    child.emit('close', 1)

    await expect(resultPromise).rejects.toMatchObject({ kind: 'daemon-down', exitCode: 1 })
  })

  it('rejects when the signal was aborted, even if the process happens to exit 0', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const controller = new AbortController()
    const resultPromise = runner.stream(['build', '.'], () => {}, controller.signal)
    controller.abort()
    child.emit('close', 0)

    await expect(resultPromise).rejects.toMatchObject({ kind: 'failed' })
  })

  it('rejects with not-installed on an ENOENT spawn error', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const resultPromise = runner.stream(['build', '.'], () => {}, new AbortController().signal)
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))

    await expect(resultPromise).rejects.toMatchObject({ kind: 'not-installed' })
  })

  it('classifies a non-ENOENT spawn error via stderr, like run() does', async () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'docker')
    process.env.PATH = binDir
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const runner = createDockerRunner({ refusalRoots: () => [] })
    const resultPromise = runner.stream(['build', '.'], () => {}, new AbortController().signal)
    child.stderr.emit('data', Buffer.from('permission denied while trying to connect to the docker.sock'))
    child.emit('error', new Error('EACCES'))

    await expect(resultPromise).rejects.toMatchObject({ kind: 'no-permission' })
  })
})

// ── FakeDockerRunner ─────────────────────────────────────────────────────

describe('FakeDockerRunner', () => {
  it('records calls and replays a scripted result keyed by argv prefix', async () => {
    const fake = new FakeDockerRunner()
    fake.script(['inspect'], { result: { stdout: '{}', stderr: '', exitCode: 0 } })

    const result = await fake.run(['inspect', 'co-sandbox-x'])
    expect(result).toEqual({ stdout: '{}', stderr: '', exitCode: 0 })
    expect(fake.calls).toEqual([{ method: 'run', args: ['inspect', 'co-sandbox-x'], opts: undefined }])
  })

  it('replays a scripted error', async () => {
    const fake = new FakeDockerRunner()
    fake.script(['start'], { error: { kind: 'daemon-down', exitCode: 1 } })
    await expect(fake.run(['start', 'co-sandbox-x'])).rejects.toMatchObject({ kind: 'daemon-down' })
  })

  it('an unscripted call succeeds with an empty result', async () => {
    const fake = new FakeDockerRunner()
    await expect(fake.run(['anything'])).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 })
  })

  it('binary() defaults to available, overridable via setBinary', () => {
    const fake = new FakeDockerRunner()
    expect(fake.binary()).toEqual({ available: true, absPath: '/usr/bin/docker' })
    fake.setBinary({ available: false, reason: 'not-found' })
    expect(fake.binary()).toEqual({ available: false, reason: 'not-found' })
  })

  it('stream() replays scripted lines to onLine before settling', async () => {
    const fake = new FakeDockerRunner()
    fake.setStreamLines(['step 1', 'step 2'])
    const lines: string[] = []
    await fake.stream(['build', '.'], (l) => lines.push(l), new AbortController().signal)
    expect(lines).toEqual(['step 1', 'step 2'])
  })

  it('stream() throws when the signal is already aborted', async () => {
    const fake = new FakeDockerRunner()
    const controller = new AbortController()
    controller.abort()
    await expect(fake.stream(['build', '.'], () => {}, controller.signal)).rejects.toMatchObject({ kind: 'failed' })
  })
})

describe('describeDockerError (BE-M6)', () => {
  it('lists kind, subkind, exit code and the stderr tail on one line', () => {
    const err = new DockerError('failed', { subkind: 'port-conflict', exitCode: 125, stderrTail: 'port is already allocated\nsecond line' })
    expect(describeDockerError(err)).toBe('kind=failed subkind=port-conflict exit=125 stderr="port is already allocated\\nsecond line"')
  })

  it('shows a missing exit code and caps stderr at 2 KB', () => {
    const err = new DockerError('timeout', { exitCode: null, stderrTail: 'x'.repeat(10_000) })
    const line = describeDockerError(err)
    expect(line.startsWith('kind=timeout exit=none stderr="')).toBe(true)
    expect(line.length).toBeLessThan(2_200)
  })
})
