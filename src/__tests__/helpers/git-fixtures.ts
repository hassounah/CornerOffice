import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { vi } from 'vitest'
import type { GitService, RepoCtx, GitRunOpts, GitRunResult } from '../../main/services/git-runner'

// ---------------------------------------------------------------------------
// git-fixtures.ts — real temp git repos with a hermetic env, shared by the
// git-service test suites (steps 1.11+). Tests are unrestricted from the
// child_process ban (Sec M-9); this file only ever calls the real `git`
// binary directly, for test setup — production code never does.
// ---------------------------------------------------------------------------

export function hermeticEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Drop inherited GIT_* vars: a git hook (e.g. husky pre-commit) exports
  // GIT_INDEX_FILE etc., which would point fixture repos at the outer repo.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return {
    ...inherited,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.invalid',
    ...extra,
  }
}

export function makeTmpDir(prefix = 'co-git-fixture-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: hermeticEnv() }).toString('utf-8')
}

export function initRepo(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', branch, '.'])
  git(dir, ['config', 'user.email', 'test@test.invalid'])
  git(dir, ['config', 'user.name', 'Test'])
}

export function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

export function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** A repo with a single commit on `branch`, ready for probe/base tests. */
export function makeSimpleRepo(dir: string, branch = 'main'): { headOid: string } {
  initRepo(dir, branch)
  writeFile(dir, 'readme.md', '# hello\n')
  const headOid = commitAll(dir, 'init')
  return { headOid }
}

/** Same shape as makeSimpleRepo, with a caller-chosen file/branch — the
 *  general-purpose repo builder the canary suite (step 1.14) reaches for. */
export function makeRepo(dir: string, opts: { branch?: string; fileName?: string; content?: string } = {}): { headOid: string } {
  initRepo(dir, opts.branch ?? 'main')
  writeFile(dir, opts.fileName ?? 'tracked.txt', opts.content ?? 'hello\n')
  const headOid = commitAll(dir, 'init')
  return { headOid }
}

// ---------------------------------------------------------------------------
// Security canary support (step 1.14, TRD §7.2). Each canary: (1) plants a
// vector that would touch a marker file, (2) runs every relevant hardened
// git-service op with the marker asserted absent, (3) replays the SAME
// argv the service actually issued, minus the invariant `-c` prefix and the
// security env, as a positive control — proving the vector fires on exactly
// what the service runs, not a synthetic stand-in.
// ---------------------------------------------------------------------------

export interface Marker {
  path: string
  /** A `touch <path>` command string, safe to embed directly in a git
   *  config value, hook script body, or filter command — the path itself
   *  never contains spaces (always under a mkdtemp'd tmp dir). */
  touchCmd: string
  exists: () => boolean
  clear: () => void
}

export function plantMarker(tmpDir: string, id: number | string): Marker {
  const p = path.join(tmpDir, `PWNED_${id}`)
  return {
    path: p,
    touchCmd: `touch ${p}`,
    exists: () => fs.existsSync(p),
    clear: () => fs.rmSync(p, { force: true }),
  }
}

/**
 * Runs the real git binary directly — no invariant `-c` prefix, no security
 * env (GIT_ALLOW_PROTOCOL / GIT_NO_LAZY_FETCH / GIT_OPTIONAL_LOCKS / etc.) —
 * for a canary's positive control or a captured-argv replay. Tolerant of any
 * exit code; callers only care whether the marker fired, not git's own
 * success or failure here.
 */
export function rawGit(dir: string, args: string[], env: NodeJS.ProcessEnv = hermeticEnv()): void {
  spawnSync('git', args, { cwd: dir, env, stdio: 'ignore' })
}

export interface CapturedCall {
  root: string
  args: string[]
}

/**
 * Spies on a GitService's own `runGit`, recording every (root, args) pair a
 * hardened op calls it with — still delegating to the real implementation,
 * so the op under test behaves exactly as it would unobserved. `restore`
 * MUST be called (e.g. in afterEach) to remove the spy.
 */
export function captureRunnerArgv(gitService: GitService): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = []
  const original = gitService.runGit.bind(gitService)
  const spy = vi.spyOn(gitService, 'runGit')
  spy.mockImplementation((ctx: RepoCtx, args: readonly string[], opts?: GitRunOpts): Promise<GitRunResult> => {
    calls.push({ root: ctx.root, args: [...args] })
    return original(ctx, args, opts)
  })
  return { calls, restore: () => spy.mockRestore() }
}

/** Replays one captured (root, args) pair via rawGit — the positive control:
 *  the exact subcommand the service ran, minus hardening. */
export function replayUnhardened(call: CapturedCall, env: NodeJS.ProcessEnv = hermeticEnv()): void {
  rawGit(call.root, call.args, env)
}

/**
 * The service-level hermetic override (TRD §7.2 H1): `createGitService`'s
 * `baseEnvOverrides`, pointing HOME/XDG_CONFIG_HOME/the global gitconfig at
 * an isolated tmp location and disabling the system config entirely, so the
 * service under test never reads the developer's or CI runner's real
 * global/system git config.
 */
export function serviceEnvOverrides(tmpHome: string, tmpXdg: string): NodeJS.ProcessEnv {
  return {
    HOME: tmpHome,
    XDG_CONFIG_HOME: tmpXdg,
    GIT_CONFIG_GLOBAL: path.join(tmpHome, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
}
