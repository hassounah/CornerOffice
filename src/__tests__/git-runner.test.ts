import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import {
  resolveGitBinary,
  buildEnv,
  parseGitVersion,
  redactUrlUserinfo,
  createGitService,
  gitRunnerSettings,
  GitDisabled,
  type RepoCtx,
} from '../main/services/git-runner'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-git-runner-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  gitRunnerSettings.executionDisabled = false
})

function makeExecutable(dir: string, name: string, contents = '#!/bin/sh\nexit 0\n'): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, contents)
  fs.chmodSync(p, 0o755)
  return p
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const hermeticEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.invalid',
  }
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env: hermeticEnv })
  execFileSync('git', ['config', 'user.email', 'test@test.invalid'], { cwd: dir, env: hermeticEnv })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env: hermeticEnv })
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello\n')
  execFileSync('git', ['add', '-A'], { cwd: dir, env: hermeticEnv })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: hermeticEnv })
}

function ctxFor(root: string, workspaceRoots: readonly string[] = []): RepoCtx {
  return { root, workspaceRoots }
}

// ---------------------------------------------------------------------------
// resolveGitBinary (M4)
// ---------------------------------------------------------------------------

describe('resolveGitBinary', () => {
  it('skips an empty PATH entry', () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'git')
    const pathEnv = `${path.delimiter}${binDir}`
    const result = resolveGitBinary(pathEnv, [])
    expect(result).toEqual({ available: true, absPath: fs.realpathSync(path.join(binDir, 'git')) })
  })

  it('skips a "." PATH entry', () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'git')
    const pathEnv = `.${path.delimiter}${binDir}`
    const result = resolveGitBinary(pathEnv, [])
    expect(result).toEqual({ available: true, absPath: fs.realpathSync(path.join(binDir, 'git')) })
  })

  it('skips a relative PATH entry', () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'git')
    const pathEnv = `relative/dir${path.delimiter}${binDir}`
    const result = resolveGitBinary(pathEnv, [])
    expect(result).toEqual({ available: true, absPath: fs.realpathSync(path.join(binDir, 'git')) })
  })

  it('skips a non-executable file named git', () => {
    const binDir1 = path.join(tmpDir, 'bin1')
    fs.mkdirSync(binDir1, { recursive: true })
    fs.writeFileSync(path.join(binDir1, 'git'), 'not executable')
    fs.chmodSync(path.join(binDir1, 'git'), 0o644)
    const binDir2 = path.join(tmpDir, 'bin2')
    makeExecutable(binDir2, 'git')
    const pathEnv = `${binDir1}${path.delimiter}${binDir2}`
    const result = resolveGitBinary(pathEnv, [])
    expect(result).toEqual({ available: true, absPath: fs.realpathSync(path.join(binDir2, 'git')) })
  })

  it('refuses a git binary that resolves inside a workspace root', () => {
    const binDir = path.join(tmpDir, 'workspace', 'bin')
    makeExecutable(binDir, 'git')
    const result = resolveGitBinary(binDir, [path.join(tmpDir, 'workspace')])
    expect(result).toEqual({ available: false, reason: 'inside-workspace' })
  })

  it('returns not-found when PATH has no git', () => {
    const emptyDir = path.join(tmpDir, 'empty')
    fs.mkdirSync(emptyDir)
    const result = resolveGitBinary(emptyDir, [])
    expect(result).toEqual({ available: false, reason: 'not-found' })
  })

  it('picks git.exe on win32', () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'git.exe')
    const result = resolveGitBinary(binDir, [], 'win32')
    expect(result).toEqual({ available: true, absPath: fs.realpathSync(path.join(binDir, 'git.exe')) })
  })

  it('does not pick a plain "git" file on win32', () => {
    const binDir = path.join(tmpDir, 'bin')
    makeExecutable(binDir, 'git')
    const result = resolveGitBinary(binDir, [], 'win32')
    expect(result).toEqual({ available: false, reason: 'not-found' })
  })
})

// ---------------------------------------------------------------------------
// buildEnv
// ---------------------------------------------------------------------------

describe('buildEnv', () => {
  it('strips every GIT_* key from base', () => {
    const env = buildEnv({ GIT_DIR: '/evil', PATH: '/usr/bin', GIT_FOO: 'x' }, undefined, undefined, '/repo')
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_FOO).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('always sets the security variables', () => {
    const env = buildEnv({}, undefined, undefined, '/repo')
    expect(env.GIT_ALLOW_PROTOCOL).toBe('')
    expect(env.GIT_NO_LAZY_FETCH).toBe('1')
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CEILING_DIRECTORIES).toBe(path.dirname('/repo'))
    expect(env.LC_ALL).toBe('C')
    expect(env.GIT_CONFIG_COUNT).toBe('0')
  })

  it('a hostile override cannot beat the security variables', () => {
    const env = buildEnv(
      {},
      { GIT_ALLOW_PROTOCOL: 'https', GIT_OPTIONAL_LOCKS: '1', GIT_TERMINAL_PROMPT: '1' },
      undefined,
      '/repo',
    )
    expect(env.GIT_ALLOW_PROTOCOL).toBe('')
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('sets GIT_CONFIG_COUNT=0 (not just absent) when there are no driver nulls, so a smuggled key is ignored', () => {
    // A hostile override tries to smuggle a GIT_CONFIG_KEY_0/VALUE_0 pair in
    // alongside a count of 0 — git reads GIT_CONFIG_COUNT entries only, so
    // an explicit '0' after this env is built makes the smuggled pair inert.
    const env = buildEnv({}, { GIT_CONFIG_KEY_0: 'smuggled.key', GIT_CONFIG_VALUE_0: 'smuggled' }, undefined, '/repo')
    expect(env.GIT_CONFIG_COUNT).toBe('0')
  })

  it('applies overrides for non-security keys', () => {
    const env = buildEnv({}, { CUSTOM_VAR: 'value' }, undefined, '/repo')
    expect(env.CUSTOM_VAR).toBe('value')
  })

  it('an override of undefined deletes a base key', () => {
    const env = buildEnv({ CUSTOM_VAR: 'value' }, { CUSTOM_VAR: undefined }, undefined, '/repo')
    expect(env.CUSTOM_VAR).toBeUndefined()
  })

  it('emits GIT_CONFIG_COUNT/KEY/VALUE entries for driver nulls', () => {
    const env = buildEnv({}, undefined, { 'filter.lfs.clean': '', 'filter.lfs.smudge': '' }, '/repo')
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    const pairs = [0, 1].map((i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]])
    expect(pairs).toContainEqual(['filter.lfs.clean', ''])
    expect(pairs).toContainEqual(['filter.lfs.smudge', ''])
  })
})

// ---------------------------------------------------------------------------
// parseGitVersion
// ---------------------------------------------------------------------------

describe('parseGitVersion', () => {
  it('parses a plain version string', () => {
    expect(parseGitVersion('git version 2.34.1')).toEqual({ major: 2, minor: 34, patch: 1, raw: 'git version 2.34.1' })
  })

  it('parses a version string with a distro suffix', () => {
    const v = parseGitVersion('git version 2.39.1.windows.1')
    expect(v).toMatchObject({ major: 2, minor: 39, patch: 1 })
  })

  it('returns null for unparseable input', () => {
    expect(parseGitVersion('not a version')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// redactUrlUserinfo (Sec L-1, L4)
// ---------------------------------------------------------------------------

describe('redactUrlUserinfo', () => {
  it('redacts a lowercase https URL with userinfo', () => {
    expect(redactUrlUserinfo("fatal: unable to access 'https://user:tok@host/repo.git/'")).toBe(
      "fatal: unable to access 'https://***@host/repo.git/'",
    )
  })

  it('redacts an uppercase HTTPS URL with userinfo (case-insensitive)', () => {
    expect(redactUrlUserinfo('HTTPS://USER:TOK@HOST/repo')).toBe('HTTPS://***@HOST/repo')
  })

  it('leaves text with no userinfo unchanged', () => {
    expect(redactUrlUserinfo('fatal: not a git repository')).toBe('fatal: not a git repository')
  })
})

// ---------------------------------------------------------------------------
// createGitService
// ---------------------------------------------------------------------------

describe('createGitService — construction', () => {
  it('throws when baseEnvOverrides is given while isPackaged is true', () => {
    expect(() => createGitService({ baseEnvOverrides: { X: '1' }, isPackaged: true })).toThrow()
  })

  it('does not throw when baseEnvOverrides is given and isPackaged is false', () => {
    expect(() => createGitService({ baseEnvOverrides: { X: '1' }, isPackaged: false })).not.toThrow()
  })

  it('does not throw with isPackaged true and no overrides', () => {
    expect(() => createGitService({ isPackaged: true })).not.toThrow()
  })
})

describe('createGitService — runGit', () => {
  it('runs a real git command in a temp repo', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()
    const result = await service.runGit(ctxFor(repo), ['rev-parse', 'HEAD'])
    expect(result.truncated).toBe(false)
    expect(result.stdout.toString('utf-8').trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  // Fix #138: buildEnv() itself is already unit-tested above (including
  // hostile-override resistance), but that only proves the FUNCTION is
  // correct in isolation — it says nothing about whether runGitOnce (the
  // actual execFile call site) passes its result through unmodified to the
  // real spawned process. A module-level spy/mock on `child_process` was
  // tried first and found unreliable here — Vitest's ESM module interception
  // does not consistently intercept git-runner.ts's own named import of
  // `execFile` in this project's config (confirmed empirically: two
  // different vi.mock('child_process', ...) attempts both let the real git
  // process run without ever invoking the wrapper). This test instead
  // reuses the SAME fake-binary-on-PATH technique already proven above (see
  // "abortRoot really kills an in-flight child"): a real subprocess that
  // reports its OWN received environment is unaffected by any of that
  // module-boundary uncertainty, since it's the actual OS-level env execFile
  // handed to it, not something read back through Node's module graph.
  it('the real spawned process actually receives the hardened env buildEnv() builds (not just buildEnv() in isolation)', async () => {
    const binDir = path.join(tmpDir, 'env-capture-bin')
    const captureFile = path.join(tmpDir, 'captured-env.txt')
    makeExecutable(binDir, 'git', `#!/bin/sh\nenv > "${captureFile}"\necho deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n`)
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
    try {
      const repo = path.join(tmpDir, 'repo')
      fs.mkdirSync(repo, { recursive: true })
      const service = createGitService()
      await service.runGit(ctxFor(repo), ['rev-parse', 'HEAD'])

      const captured = fs.readFileSync(captureFile, 'utf-8')
      const env: Record<string, string> = {}
      for (const line of captured.split('\n')) {
        const eq = line.indexOf('=')
        if (eq === -1) continue
        env[line.slice(0, eq)] = line.slice(eq + 1)
      }

      expect(env.GIT_OPTIONAL_LOCKS).toBe('0') // the real control for post-index-change (L9) — Fix #138's canary 2 gap
      expect(env.GIT_ALLOW_PROTOCOL).toBe('') // (C1)
      expect(env.GIT_NO_LAZY_FETCH).toBe('1')
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.LC_ALL).toBe('C')
      expect(env.GIT_CONFIG_COUNT).toBe('0') // no driverNulls passed for this call
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('throws GitDisabled when the kill switch is set', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()
    gitRunnerSettings.executionDisabled = true
    await expect(service.runGit(ctxFor(repo), ['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitDisabled)
  })

  it('the late-workspace re-check turns a previously-resolved git into unavailable', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()

    const first = await service.runGit(ctxFor(repo, []), ['rev-parse', 'HEAD'])
    expect(first.stdout.length).toBeGreaterThan(0)

    const resolved = resolveGitBinary(process.env.PATH, [])
    expect(resolved.available).toBe(true)
    if (!resolved.available) throw new Error('unreachable')
    const workspaceContainingGit = path.dirname(resolved.absPath)

    await expect(
      service.runGit(ctxFor(repo, [workspaceContainingGit]), ['rev-parse', 'HEAD']),
    ).rejects.toMatchObject({ reason: 'inside-workspace' })
  })

  it('dedups identical concurrent calls into a single in-flight promise (single-flight)', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()
    const ctx = ctxFor(repo)
    const p1 = service.runGit(ctx, ['rev-parse', 'HEAD'])
    const p2 = service.runGit(ctx, ['rev-parse', 'HEAD'])
    expect(p1).toBe(p2)
    await p1
  })

  it('does not dedup the same argv with different driver sets — two independent spawns', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()
    const ctx = ctxFor(repo)
    const [r1, r2] = await Promise.all([
      service.runGit(ctx, ['config', '--get', 'zz.marker'], { driverNulls: { 'zz.marker': 'one' } }),
      service.runGit(ctx, ['config', '--get', 'zz.marker'], { driverNulls: { 'zz.marker': 'two' } }),
    ])
    expect(r1.stdout.toString('utf-8').trim()).toBe('one')
    expect(r2.stdout.toString('utf-8').trim()).toBe('two')
  })

  it('abortRoot really kills an in-flight child and frees its semaphore slot', async () => {
    // A slow fake git that marks its own PID file on start, then hangs. This
    // proves a real spawn happened (not vacuous — see below) and lets the
    // test wait for it before aborting, rather than racing against it.
    const binDir = path.join(tmpDir, 'slow-git-bin')
    const spawnDir = path.join(tmpDir, 'spawned')
    fs.mkdirSync(spawnDir)
    makeExecutable(binDir, 'git', `#!/bin/sh\n: > "${spawnDir}/$$"\nsleep 30\n`)

    const originalPath = process.env.PATH
    // Prepend our fake git so OUR resolution picks it up, but keep the real
    // PATH behind it so the fake script's own shell can still find `sleep`.
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
    try {
      const service = createGitService()
      const repo = path.join(tmpDir, 'repo')
      fs.mkdirSync(repo, { recursive: true })
      const ctx = ctxFor(repo)

      async function waitForNewMarker(before: Set<string>, timeoutMs = 2000): Promise<void> {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const added = fs.readdirSync(spawnDir).find((f) => !before.has(f))
          if (added) return
          if (Date.now() > deadline) throw new Error('the fake git child never spawned')
          await new Promise((r) => setTimeout(r, 5))
        }
      }

      // First call: confirm it actually spawned (single-flight dedup or a
      // controller registered too late would otherwise make this vacuous),
      // THEN abort it.
      const before1 = new Set(fs.readdirSync(spawnDir))
      const first = service.runGit(ctx, ['status']).then(
        (v) => ({ rejected: false as const, value: v }),
        (e: unknown) => ({ rejected: true as const, value: e }),
      )
      await waitForNewMarker(before1)
      service.abortRoot(repo)
      const firstResult = await first
      expect(firstResult.rejected).toBe(true)
      expect(firstResult.value).toMatchObject({ code: 'INTERNAL_ERROR' })

      // Second call: must spawn promptly. If the aborted call's semaphore
      // slot had leaked, this would hang (and the test would time out)
      // rather than fail cleanly, so waitForNewMarker's own deadline is what
      // turns that failure mode into a clear assertion.
      const before2 = new Set(fs.readdirSync(spawnDir))
      const second = service.runGit(ctx, ['status', '--porcelain']).catch((e: unknown) => e)
      await waitForNewMarker(before2)
      service.abortRoot(repo) // clean up — don't let the fake child sleep out the full 30s
      await second
    } finally {
      process.env.PATH = originalPath
    }
  }, 10_000)

  it('caps concurrent git children at 4 across multiple roots (app-wide semaphore)', async () => {
    const binDir = path.join(tmpDir, 'slow-git-bin-2')
    const spawnDir = path.join(tmpDir, 'spawned-2')
    fs.mkdirSync(spawnDir)
    makeExecutable(binDir, 'git', `#!/bin/sh\n: > "${spawnDir}/$$"\nsleep 30\n`)

    const originalPath = process.env.PATH
    // Prepend our fake git so OUR resolution picks it up, but keep the real
    // PATH behind it so the fake script's own shell can still find `sleep`.
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
    try {
      const service = createGitService()
      const roots = ['root-a', 'root-b', 'root-c'].map((name) => {
        const root = path.join(tmpDir, name)
        fs.mkdirSync(root, { recursive: true })
        return root
      })

      const calls = roots.flatMap((root) =>
        Array.from({ length: 3 }, (_, i) =>
          service.runGit(ctxFor(root), ['status', `--x${i}`]).catch((e: unknown) => e),
        ),
      )

      // Poll while all 9 calls are outstanding, tracking the peak number of
      // children that actually started (TRD §9.3: an app-wide cap of 4, not
      // 4 per root — 3 roots x 4 would allow up to 12 concurrent spawns).
      let peak = 0
      const pollDeadline = Date.now() + 500
      while (Date.now() < pollDeadline) {
        peak = Math.max(peak, fs.readdirSync(spawnDir).length)
        await new Promise((r) => setTimeout(r, 5))
      }

      expect(peak).toBeGreaterThan(0) // sanity: something did spawn
      expect(peak).toBeLessThanOrEqual(4)

      // Cleanup: a single abortRoot pass only reaches whatever has already
      // spawned. Freeing those slots lets the next queued call spawn (and
      // sleep 30s) in turn, so keep aborting until every call has settled
      // rather than leaving later spawns to run out their own timeout.
      let settled = 0
      for (const call of calls) call.then(() => settled++)
      const cleanupDeadline = Date.now() + 5000
      while (settled < calls.length && Date.now() < cleanupDeadline) {
        for (const root of roots) service.abortRoot(root)
        await new Promise((r) => setTimeout(r, 20))
      }
      await Promise.all(calls)
    } finally {
      process.env.PATH = originalPath
    }
  }, 10_000)

  it('truncates at the last NUL on maxBuffer overflow and sets truncated: true', async () => {
    const repo = path.join(tmpDir, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const hermeticEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.invalid' }
    execFileSync('git', ['init', '-q', '.'], { cwd: repo, env: hermeticEnv })
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(repo, `file${i}.txt`), 'x')
    execFileSync('git', ['add', '-A'], { cwd: repo, env: hermeticEnv })
    execFileSync('git', ['commit', '-q', '-m', 'many files'], { cwd: repo, env: hermeticEnv })

    const service = createGitService()
    const result = await service.runGit(ctxFor(repo), ['ls-files', '-z'], { maxBuffer: 100 })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(100)
    // Every record kept is complete (NUL-terminated); no partial trailing name.
    expect(result.stdout[result.stdout.length - 1]).toBe(0)
  })

  it('maps a timeout to the TIMEOUT error code', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()
    await expect(
      service.runGit(ctxFor(repo), ['rev-parse', 'HEAD'], { timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('allowExit treats a listed nonzero exit code as success', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()
    // `rev-parse --verify` on a nonexistent ref exits 128.
    await expect(
      service.runGit(ctxFor(repo), ['rev-parse', '--verify', 'nonexistent-ref']),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

    const result = await service.runGit(ctxFor(repo), ['rev-parse', '--verify', 'nonexistent-ref'], {
      allowExit: [128],
    })
    expect(result.truncated).toBe(false)
  })

  it('a generic (non-allowlisted) failure carries redacted stderr for the caller to classify', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const service = createGitService()
    // A real, deterministic git error: not a git repository (used e.g. by
    // git-service.ts's probe classifier — LC_ALL=C keeps the message stable).
    const emptyDir = path.join(tmpDir, 'not-a-repo')
    fs.mkdirSync(emptyDir)
    await expect(service.runGit(ctxFor(emptyDir), ['rev-parse', '--show-toplevel'])).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      stderr: expect.stringContaining('not a git repository'),
    })
  })

  it('rejects when git is not available for the given ctx', async () => {
    const repo = path.join(tmpDir, 'repo')
    initRepo(repo)
    const emptyPathDir = path.join(tmpDir, 'no-git-here')
    fs.mkdirSync(emptyPathDir)
    const originalPath = process.env.PATH
    process.env.PATH = emptyPathDir
    try {
      const service = createGitService()
      await expect(service.runGit(ctxFor(repo), ['rev-parse', 'HEAD'])).rejects.toThrow()
    } finally {
      process.env.PATH = originalPath
    }
  })
})

describe('createGitService — getVersion', () => {
  it('parses the real installed git version', async () => {
    const service = createGitService()
    const info = await service.getVersion()
    expect(info.state).not.toBe('unavailable')
    if (info.state !== 'unavailable') {
      expect(info.version.major).toBeGreaterThanOrEqual(2)
    }
  })

  it('caches the version across calls', async () => {
    const service = createGitService()
    const first = await service.getVersion()
    const second = await service.getVersion()
    expect(second).toBe(first)
  })

  it('reports unavailable when git cannot be found', async () => {
    const emptyPathDir = path.join(tmpDir, 'no-git-here')
    fs.mkdirSync(emptyPathDir)
    const originalPath = process.env.PATH
    process.env.PATH = emptyPathDir
    try {
      const service = createGitService()
      const info = await service.getVersion()
      expect(info.state).toBe('unavailable')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('reports too-old for a git below the 2.31 floor', async () => {
    const binDir = path.join(tmpDir, 'old-git-bin')
    makeExecutable(binDir, 'git', '#!/bin/sh\necho "git version 2.20.0"\n')
    const originalPath = process.env.PATH
    process.env.PATH = binDir
    try {
      const service = createGitService()
      const info = await service.getVersion()
      expect(info.state).toBe('too-old')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('reports unavailable when --version output cannot be parsed', async () => {
    const binDir = path.join(tmpDir, 'garbled-git-bin')
    makeExecutable(binDir, 'git', '#!/bin/sh\necho "not a version"\n')
    const originalPath = process.env.PATH
    process.env.PATH = binDir
    try {
      const service = createGitService()
      const info = await service.getVersion()
      expect(info.state).toBe('unavailable')
    } finally {
      process.env.PATH = originalPath
    }
  })
})
