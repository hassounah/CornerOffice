import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { createGitService } from '../main/services/git-runner'
import { createRepoService } from '../main/services/git-service'
import {
  makeTmpDir,
  makeRepo,
  git,
  writeFile,
  hermeticEnv,
  plantMarker,
  rawGit,
  captureRunnerArgv,
  replayUnhardened,
  serviceEnvOverrides,
} from './helpers/git-fixtures'
import type { Marker, CapturedCall } from './helpers/git-fixtures'

// ---------------------------------------------------------------------------
// git-canaries.test.ts — Security canary suite 1-13 (Step 1.14, TRD §7.2,
// H1, C1, H3, M1, L9; Sec H-5, M-7, L-3; Be M1).
//
// Each canary: (1) plants a repo-local (or process-env) vector that would
// `touch <tmp>/PWNED_<n>`; (2) runs every relevant hardened git-service op
// with a spy capturing the exact argv each call issues, asserting BOTH
// liveness (the op returns a real, successful result — an error, a timeout,
// `git-unsafe` or `INTERNAL_ERROR` fails the test, Sec H-5) and that the
// marker stays absent; (3) replays the captured argv through the real git
// binary WITHOUT the invariant `-c` prefix and WITHOUT the security env —
// at least one replay MUST create the marker, or the test fails with
// "canary precondition not met" (the vector wasn't actually live, so the
// "absent" assertion above would have been meaningless).
//
// Some vectors (2, 7, 8) turn out to be structurally unreachable through the
// SPECIFIC git subcommands this service's ops issue (none of them refresh
// the index, allocate a tty, or invoke signature verification) — for those,
// replaying the service's own argv can never fire the marker no matter what,
// so a HAND-WRITTEN control (a different invocation shape that DOES fire the
// vector, with and without the relevant hardening) is used instead, exactly
// as the plan authorizes for canary 2. The hardening stays in place as a
// defense-in-depth layer for whatever a future op might add.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

function tmpDir(prefix?: string): string {
  const dir = makeTmpDir(prefix)
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** One isolated service per canary, with its OWN tmpHome/tmpXdg — never the
 *  real developer/CI HOME (TRD §7.2 H1). */
function makeCanaryService() {
  const tmpHome = tmpDir('co-canary-home-')
  const tmpXdg = tmpDir('co-canary-xdg-')
  const gitService = createGitService({ baseEnvOverrides: serviceEnvOverrides(tmpHome, tmpXdg) })
  const repoService = createRepoService(gitService)
  return { gitService, repoService, tmpHome, tmpXdg }
}

/** Replays every captured call until one creates the marker, clears it, and
 *  returns. Throws the exact required failure message otherwise. */
function replayUntilFired(calls: readonly CapturedCall[], marker: Marker, env?: NodeJS.ProcessEnv): void {
  for (const call of calls) {
    replayUnhardened(call, env)
    if (marker.exists()) {
      marker.clear()
      return
    }
  }
  throw new Error('canary precondition not met')
}

// ---------------------------------------------------------------------------
// Canary 1 — core.fsmonitor as a command (probe, status, index, checkIgnore)
// ---------------------------------------------------------------------------

describe('canary 1 — core.fsmonitor command', () => {
  it('every hardened op stays live with the marker absent; replay of the captured argv fires it', async () => {
    const root = tmpDir()
    makeRepo(root)
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 1)
    git(root, ['config', 'core.fsmonitor', marker.touchCmd])

    const capture = captureRunnerArgv(gitService)
    try {
      const info = await repoService.getRepoInfo(root, [])
      expect(info.state).toBe('git')
      expect(marker.exists()).toBe(false)

      const status = await repoService.getStatus(root, [], 'head')
      expect(status.repo.state).toBe('git')
      expect(marker.exists()).toBe(false)

      const index = await repoService.getFileIndex(root, [], false)
      expect(index.paths).toContain('tracked.txt')
      expect(marker.exists()).toBe(false)

      const ignored = await repoService.checkIgnore(root, [], ['tracked.txt'])
      expect(ignored.size).toBe(0)
      expect(marker.exists()).toBe(false)
    } finally {
      capture.restore()
    }

    replayUntilFired(capture.calls, marker)
  })
})

// ---------------------------------------------------------------------------
// Canary 2 — .git/hooks/post-index-change (status)
// Documented outcome: status() never calls plain `git status` (only
// diff/ls-files), so replaying its own argv can never refresh the index or
// fire this hook — GIT_OPTIONAL_LOCKS=0 guards a path the service does not
// take today. Kept as a layer; the racy-clean `git status` control below is
// the hand-written proof that the env var itself is real and effective.
//
// Fix #138: unlike canaries 3/6/10/11 (whose env-based hardening — driverNulls,
// GIT_* stripping, GIT_NO_LAZY_FETCH/GIT_ALLOW_PROTOCOL — DOES get exercised
// by the service's own real first-liveness call above, since their vectors
// intersect with operations status()/readBlob() actually perform), canary
// 2 is structurally unable to prove GIT_OPTIONAL_LOCKS=0 reaches a REAL
// spawned process this same way, because no service op ever refreshes the
// index at all. That real-wiring proof lives instead in git-runner.test.ts
// ("the real spawned process actually receives the hardened env buildEnv()
// builds") — a fake-git-binary-on-PATH test that captures the actual OS-level
// environment a real runGit() call spawns with and asserts
// GIT_OPTIONAL_LOCKS/GIT_ALLOW_PROTOCOL/GIT_NO_LAZY_FETCH/etc. directly,
// sabotage-tested to confirm it goes red if any of them is removed from
// buildEnv(). Together: buildEnv() unit tests (git-runner.test.ts, isolated
// correctness + hostile-override resistance) + that real-spawn env-capture
// test (git-runner.test.ts, proves buildEnv()'s result reaches the actual
// child process) + this file's hand-written vector/effectiveness proof below
// cover the full chain end-to-end, without needing to intercept
// child_process at the module level (tried first; Vitest's ESM interception
// did not reliably catch git-runner.ts's own `execFile` import in this
// project's config — two different vi.mock('child_process', ...) attempts
// both let the real process spawn without the wrapper ever firing).
// ---------------------------------------------------------------------------

describe('canary 2 — .git/hooks/post-index-change (documented: no service op takes this path today)', () => {
  it('the hook never fires via status()\'s own argv; GIT_OPTIONAL_LOCKS=0 is proven live via a hand-written racy-clean git status control', async () => {
    const root = tmpDir()
    makeRepo(root)
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 2)
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\n${marker.touchCmd}\n`)
    fs.chmodSync(path.join(root, '.git', 'hooks', 'post-index-change'), 0o755)
    writeFile(root, 'tracked.txt', 'changed\n') // gives a racy-clean `git status` something to refresh
    // Deterministic staleness (flake fix, seen once under full-suite load):
    // git's index-refresh-on-status decision compares the file's mtime
    // against the on-disk .git/index's own mtime, at whatever granularity
    // the filesystem happens to offer under load — a real but narrow window
    // for the two to read as equal. Backdating the index file itself by a
    // full day makes the comparison unambiguous every time, independent of
    // system load or filesystem timestamp resolution, without changing
    // what's actually being tested (the hook still only fires from an
    // on-disk index WRITE, which this doesn't perform — it only guarantees
    // git's own subsequent write is triggered reliably).
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    fs.utimesSync(path.join(root, '.git', 'index'), dayAgo, dayAgo)

    const capture = captureRunnerArgv(gitService)
    try {
      const status = await repoService.getStatus(root, [], 'head')
      expect(status.repo.state).toBe('git')
      expect(marker.exists()).toBe(false)
    } finally {
      capture.restore()
    }

    // Replay every one of status()'s real diff/ls-files calls — none of
    // them refresh the index, so none fire the hook (the documented,
    // expected outcome for this canary).
    for (const call of capture.calls) {
      rawGit(call.root, call.args, hermeticEnv())
    }
    expect(marker.exists()).toBe(false)

    // Hand-written control (§D-9): plain `git status` DOES refresh the
    // index and fire the hook without GIT_OPTIONAL_LOCKS=0 — proving the
    // vector itself is real — and does NOT fire it with GIT_OPTIONAL_LOCKS=0,
    // proving the env var is an effective, ready-to-go guard.
    rawGit(root, ['status'], hermeticEnv())
    if (!marker.exists()) throw new Error('canary precondition not met')
    marker.clear()

    rawGit(root, ['status'], hermeticEnv({ GIT_OPTIONAL_LOCKS: '0' }))
    expect(marker.exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Canary 3 — filter.<x>.clean/process + required=true, via include.path,
// with a driver name containing "=" (status). git-attributes syntax has no
// escape for a literal space inside an attribute name (only within a
// pattern), so "=" alone is what exercises the documented rationale for
// GIT_CONFIG_COUNT-based neutralization: driver names are repo-controlled
// and may contain "=", which `-c filter.<name>.clean=` can't disambiguate
// from the value assignment, but the env mechanism can.
// ---------------------------------------------------------------------------

describe('canary 3 — filter driver via include.path, name containing "=", required=true', () => {
  it('the driver never runs during status() (neutralized via GIT_CONFIG_COUNT, not -c); replay proves the vector', async () => {
    const root = tmpDir()
    makeRepo(root, { fileName: 'tracked.txt', content: 'original\n' })
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 3)

    const includedConfig = path.join(root, 'included.gitconfig')
    fs.writeFileSync(includedConfig, `[filter "we=ird"]\n\tclean = ${marker.touchCmd}\n\trequired = true\n`)
    git(root, ['config', 'include.path', includedConfig])
    fs.writeFileSync(path.join(root, '.gitattributes'), '* filter=we=ird\n')
    writeFile(root, 'tracked.txt', 'changed\n')

    const capture = captureRunnerArgv(gitService)
    try {
      const status = await repoService.getStatus(root, [], 'head')
      expect(status.repo.state).toBe('git')
      expect(status.changes.some((c) => c.relPath === 'tracked.txt')).toBe(true)
      expect(marker.exists()).toBe(false)
    } finally {
      capture.restore()
    }

    replayUntilFired(capture.calls, marker)
  })
})

// ---------------------------------------------------------------------------
// Canary 4 — diff.<x>.textconv and diff.<x>.command (status, readBaseline)
// ---------------------------------------------------------------------------

describe('canary 4 — diff.<x>.textconv and diff.<x>.command', () => {
  it('neither fires for status() or readBlob(); a plain content-mode diff replay proves the vector, --no-textconv neutralizes it', async () => {
    const root = tmpDir()
    makeRepo(root, { fileName: 'tracked.txt', content: 'original\n' })
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 4)
    git(root, ['config', 'diff.x.textconv', `${marker.touchCmd}; cat`])
    git(root, ['config', 'diff.x.command', marker.touchCmd])
    fs.writeFileSync(path.join(root, '.gitattributes'), 'tracked.txt diff=x\n')
    writeFile(root, 'tracked.txt', 'changed\n')

    const capture = captureRunnerArgv(gitService)
    try {
      const status = await repoService.getStatus(root, [], 'head')
      expect(status.repo.state).toBe('git')
      expect(marker.exists()).toBe(false)

      const blob = await repoService.readBlob(root, [], 'head', 'tracked.txt', undefined)
      expect(blob.kind).toBe('text')
      expect(marker.exists()).toBe(false)
    } finally {
      capture.restore()
    }

    // status()'s own argv is --numstat/--name-status, which never invoke
    // textconv or the per-path diff.command driver regardless of the flags
    // (they render stats, not content) — replaying it can't prove the
    // vector. A plain content-mode `git diff` (what --no-textconv and
    // --no-ext-diff actually guard) is the real positive control. Both
    // drivers are configured on the same path here, so both flags together
    // — exactly the pair status() always passes — are needed to fully
    // neutralize it.
    rawGit(root, ['diff', '--', 'tracked.txt'], hermeticEnv())
    if (!marker.exists()) throw new Error('canary precondition not met')
    marker.clear()

    rawGit(root, ['diff', '--no-textconv', '--no-ext-diff', '--', 'tracked.txt'], hermeticEnv())
    expect(marker.exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Canary 5 — diff.external (status)
// ---------------------------------------------------------------------------

describe('canary 5 — diff.external', () => {
  it('never fires during status(); replay of the captured argv without --no-ext-diff proves the vector', async () => {
    const root = tmpDir()
    makeRepo(root, { fileName: 'tracked.txt', content: 'original\n' })
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 5)
    git(root, ['config', 'diff.external', marker.touchCmd])
    writeFile(root, 'tracked.txt', 'changed\n')

    const capture = captureRunnerArgv(gitService)
    try {
      const status = await repoService.getStatus(root, [], 'head')
      expect(status.repo.state).toBe('git')
      expect(marker.exists()).toBe(false)
    } finally {
      capture.restore()
    }

    // status()'s own argv always includes --no-ext-diff, which alone
    // defeats diff.external — the positive control needs a plain content
    // diff without that flag to prove the config itself is a live vector.
    rawGit(root, ['diff', '--', 'tracked.txt'], hermeticEnv())
    if (!marker.exists()) throw new Error('canary precondition not met')
    marker.clear()
  })
})

// ---------------------------------------------------------------------------
// Canary 6 — inherited GIT_EXTERNAL_DIFF, GIT_DIR, GIT_CONFIG_PARAMETERS,
// GIT_CONFIG_COUNT/KEY_0/VALUE_0 and GIT_ALLOW_PROTOCOL in process.env (all)
// ---------------------------------------------------------------------------

describe('canary 6 — inherited GIT_* env vars in process.env (Sec L-3)', () => {
  const keys = [
    'GIT_EXTERNAL_DIFF',
    'GIT_DIR',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_ALLOW_PROTOCOL',
  ] as const
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {}

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k]
  })

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('every hardened op strips every GIT_* var from process.env before spawning; every op stays live', async () => {
    const root = tmpDir()
    makeRepo(root, { fileName: 'tracked.txt', content: 'original\n' })
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 6)
    writeFile(root, 'tracked.txt', 'changed\n')
    // Captured BEFORE process.env is polluted below — the positive control
    // needs a clean env (no hostile GIT_DIR etc.) plus only GIT_EXTERNAL_DIFF,
    // not the full hostile set, which would break git outright.
    const cleanEnv = hermeticEnv()

    process.env.GIT_EXTERNAL_DIFF = marker.touchCmd
    process.env.GIT_DIR = '/nonexistent/hostile-gitdir'
    process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=touch /nonexistent'"
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'
    process.env.GIT_CONFIG_VALUE_0 = marker.touchCmd
    process.env.GIT_ALLOW_PROTOCOL = 'ext:file'

    const info = await repoService.getRepoInfo(root, [])
    expect(info.state).toBe('git')
    expect(marker.exists()).toBe(false)

    const capture = captureRunnerArgv(gitService)
    let status
    try {
      status = await repoService.getStatus(root, [], 'head')
    } finally {
      capture.restore()
    }
    expect(status.repo.state).toBe('git')
    expect(marker.exists()).toBe(false)

    const index = await repoService.getFileIndex(root, [], false)
    expect(index.paths).toContain('tracked.txt')
    expect(marker.exists()).toBe(false)

    const ignored = await repoService.checkIgnore(root, [], ['tracked.txt'])
    expect(ignored.size).toBe(0)
    expect(marker.exists()).toBe(false)

    const blob = await repoService.readBlob(root, [], 'head', 'tracked.txt', undefined)
    expect(blob.kind).toBe('text')
    expect(marker.exists()).toBe(false)

    // Positive control for GIT_EXTERNAL_DIFF specifically: status()'s own
    // argv always includes --no-ext-diff (a second, independent layer), so
    // replaying it can't isolate the env-stripping layer on its own. A
    // plain content diff without that flag, with an otherwise-clean env
    // (captured before the hostile GIT_DIR etc. above were set — those
    // would just break git outright, not demonstrate the vector) plus only
    // GIT_EXTERNAL_DIFF, proves it's a live vector on its own.
    rawGit(root, ['diff', '--', 'tracked.txt'], { ...cleanEnv, GIT_EXTERNAL_DIFF: marker.touchCmd })
    if (!marker.exists()) throw new Error('canary precondition not met')
    marker.clear()
  })
})

// ---------------------------------------------------------------------------
// Canary 7 — core.pager / pager.diff (all)
// Documented outcome: git only pages when stdout is a real tty; execFile
// never attaches one, so no hardened op can ever trigger this regardless of
// --no-pager. The positive control needs a faked pty (via the `script`
// utility) to reproduce the vector at all, proving --no-pager is still an
// effective, ready-to-go layer for a hypothetical future tty-attached call.
// ---------------------------------------------------------------------------

describe('canary 7 — core.pager / pager.diff (documented: execFile never attaches a tty)', () => {
  it('never fires for any hardened op; a faked-tty replay proves the vector and --no-pager', async () => {
    const root = tmpDir()
    makeRepo(root, { fileName: 'tracked.txt', content: 'original\n' })
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 7)
    git(root, ['config', 'core.pager', `${marker.touchCmd}; cat`])
    git(root, ['config', 'pager.diff', `${marker.touchCmd}; cat`])
    writeFile(root, 'tracked.txt', 'changed\n')

    const capture = captureRunnerArgv(gitService)
    try {
      const info = await repoService.getRepoInfo(root, [])
      expect(info.state).toBe('git')
      const status = await repoService.getStatus(root, [], 'head')
      expect(status.repo.state).toBe('git')
      expect(marker.exists()).toBe(false)
    } finally {
      capture.restore()
    }

    let scriptAvailable = true
    try {
      execFileSync('script', ['--version'], { stdio: 'ignore' })
    } catch {
      scriptAvailable = false
    }
    if (!scriptAvailable) return // hand-written control needs a real pty helper — skip where unavailable

    // Positive control: a git invocation given a real pty (via `script`)
    // DOES invoke the pager (core.pager is configured, so a plain command
    // under a real tty pages by default — no flag needed), and does NOT
    // once --no-pager is added (the flag must come last / alone, since a
    // later --paginate would re-enable it — so the neutralized call omits
    // --paginate entirely rather than relying on flag ordering).
    execFileSync('script', ['-qec', `git diff -- tracked.txt`, '/dev/null'], { cwd: root, env: hermeticEnv() })
    if (!marker.exists()) throw new Error('canary precondition not met')
    marker.clear()

    execFileSync('script', ['-qec', `git --no-pager diff -- tracked.txt`, '/dev/null'], { cwd: root, env: hermeticEnv() })
    expect(marker.exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Canary 8 — log.showSignature + gpg.program (probe, resolveBase)
// Documented outcome: rev-parse/symbolic-ref/merge-base are plumbing
// commands that never perform signature verification, regardless of commit
// signing state — unlike git log/show/verify-commit. -c log.showSignature=false
// is kept as a defense-in-depth layer for any future op that might add one
// of those commands.
//
// Fix #134: the positive control below is REAL, not just a replay of
// (non-triggering) captured argv — gpg.program is invoked via execv, never a
// shell (unlike core.pager/diff.external/core.fsmonitor, which git runs
// through `sh -c`), so its value must be a real executable file, and
// GPG verification only ever runs against a commit that actually carries a
// `gpgsig` header. `makeFakeSignedCommit` builds exactly that — a syntactically
// signed (but not cryptographically valid — gpg.program is faked out before
// any real verification would happen) commit object via `hash-object`, with
// no real GPG key or binary required.
// ---------------------------------------------------------------------------

/** A commit object with a `gpgsig` header, built directly via `hash-object`
 *  (no real signing key needed) — the one shape that makes `gpg.program`
 *  reachable at all; log.showSignature=true alone does nothing against an
 *  unsigned commit. */
function makeFakeSignedCommit(root: string): string {
  const treeOid = git(root, ['rev-parse', 'HEAD^{tree}']).trim()
  const body = [
    `tree ${treeOid}`,
    'author T <t@t.invalid> 1577836800 +0000',
    'committer T <t@t.invalid> 1577836800 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' iQEzBAABCAAdFiEEfakefakefakefakefakefakefakefakeFAAKCRD',
    ' fakefakefakefakefakefakefakefakefakefakefakefake=fake',
    ' -----END PGP SIGNATURE-----',
    '',
    'fake signed commit',
    '',
  ].join('\n')
  return execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
    cwd: root,
    env: hermeticEnv(),
    input: body,
  })
    .toString('utf-8')
    .trim()
}

/** gpg.program is invoked directly (execv), never through a shell — a
 *  `sh -c '...'` STRING as the config value (the pattern used for
 *  core.pager/diff.external elsewhere in this file) fails with "No such
 *  file or directory" instead of running. A real executable script file is
 *  required. */
function writeFakeGpgProgram(marker: Marker): string {
  const scriptPath = `${marker.path}.gpg-program.sh`
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${marker.touchCmd}\nexit 1\n`)
  fs.chmodSync(scriptPath, 0o755)
  return scriptPath
}

describe('canary 8 — log.showSignature + gpg.program (documented: probe/resolveBase never verify signatures)', () => {
  it('never fires for probe or resolveBase; a real fake-signed-commit replay proves the vector, and -c log.showSignature=false neutralizes it', async () => {
    const root = tmpDir()
    makeRepo(root)
    const { gitService, repoService } = makeCanaryService()
    const marker = plantMarker(root, 8)
    const gpgProgram = writeFakeGpgProgram(marker)
    git(root, ['config', 'log.showSignature', 'true'])
    git(root, ['config', 'gpg.program', gpgProgram])

    const capture = captureRunnerArgv(gitService)
    try {
      const info = await repoService.getRepoInfo(root, []) // exercises probe + resolveBase
      expect(info.state).toBe('git')
      expect(marker.exists()).toBe(false)
    } finally {
      capture.restore()
    }

    // Replaying the service's own (plumbing-only) argv can't prove the
    // vector — none of those commands ever verify a signature regardless of
    // commit content. The real positive control needs an actual signed
    // commit and `git log`, the porcelain command that does.
    for (const call of capture.calls) {
      rawGit(call.root, call.args, hermeticEnv())
    }
    expect(marker.exists()).toBe(false)

    const fakeSignedOid = makeFakeSignedCommit(root)
    rawGit(root, ['log', '-1', fakeSignedOid], hermeticEnv())
    if (!marker.exists()) throw new Error('canary precondition not met')
    marker.clear()

    rawGit(root, ['-c', 'log.showSignature=false', 'log', '-1', fakeSignedOid], hermeticEnv())
    expect(marker.exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Canary 9 — core.worktree outside root (detection only, Be M1)
// ---------------------------------------------------------------------------

describe('canary 9 — core.worktree outside root (detection only)', () => {
  it('probe reports root-mismatch; no marker, no positive control', async () => {
    const root = tmpDir()
    makeRepo(root)
    const elsewhere = tmpDir()
    git(root, ['config', 'core.worktree', elsewhere])
    const { repoService } = makeCanaryService()
    const info = await repoService.getRepoInfo(root, [])
    expect(info.state).toBe('root-mismatch')
  })
})

// ---------------------------------------------------------------------------
// Canaries 10 & 11 — blob-less partial clone, malicious lazy-fetch remote
// (readBaseline, getStatus's branch baseline against a rev with a missing
// blob). Sec C1: no fetch is ever attempted.
// ---------------------------------------------------------------------------

/** A `--filter=blob:none` clone whose CURRENT (v2) blob is present but whose
 *  OLDER (v1) blob is genuinely missing locally — exactly the shape a
 *  branch-baseline diff or readBaseline against an older rev would hit. */
function makePartialCloneWithMissingBlob(): { clone: string; oldOid: string } {
  const origin = tmpDir()
  git(origin, ['init', '-q', '-b', 'main', origin])
  git(origin, ['config', 'user.email', 'test@test.invalid'])
  git(origin, ['config', 'user.name', 'Test'])
  writeFile(origin, 'f.txt', 'v1 content\n')
  git(origin, ['add', '-A'])
  git(origin, ['commit', '-q', '-m', 'v1'])
  const oldOid = git(origin, ['rev-parse', 'HEAD']).trim()
  writeFile(origin, 'f.txt', 'v2 content\n')
  git(origin, ['add', '-A'])
  git(origin, ['commit', '-q', '-m', 'v2'])
  git(origin, ['config', 'uploadpack.allowFilter', 'true'])
  git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])

  const clone = tmpDir()
  fs.rmdirSync(clone) // git clone needs the target to not exist (or be empty)
  execFileSync(
    'git',
    ['clone', '-q', '--no-local', '--filter=blob:none', '--no-checkout', `file://${origin}`, clone],
    { env: hermeticEnv() },
  )
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: clone, env: hermeticEnv() })

  return { clone, oldOid }
}

describe('canary 10 (C1) — blob-less partial clone, ext:: lazy-fetch remote', () => {
  it('readBaseline returns unavailable, getStatus stays live with approximate:true; replay via the ext:: remote proves the vector', async () => {
    const { clone: root, oldOid } = makePartialCloneWithMissingBlob()
    const oldBlobOid = git(root, ['rev-parse', `${oldOid}:f.txt`]).trim()

    // Precondition: the blob really is missing locally under the same
    // hardening the service uses (no fetch ever attempted, C1).
    let missing = false
    try {
      execFileSync('git', ['cat-file', '-e', oldBlobOid], {
        cwd: root,
        env: hermeticEnv({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }),
      })
    } catch {
      missing = true
    }
    if (!missing) throw new Error('canary precondition not met: the blob was not actually missing')

    const marker = plantMarker(root, 10)
    git(root, ['remote', 'set-url', 'origin', `ext::sh -c touch% ${marker.path}`])
    git(root, ['config', 'protocol.ext.allow', 'always'])

    const { gitService, repoService } = makeCanaryService()
    // readBlob reuses the cache populated by a prior getRepoInfo/getStatus
    // call (it never probes on its own) — prime it first.
    await repoService.getRepoInfo(root, [])
    const capture = captureRunnerArgv(gitService)
    try {
      const blob = await repoService.readBlob(root, [], 'head', 'f.txt', undefined)
      expect(blob.kind).toBe('text') // HEAD's own blob (v2) is present — sanity check only
    } finally {
      capture.restore()
    }
    expect(marker.exists()).toBe(false)

    // The real "missing blob" liveness check: getStatus's branch baseline,
    // once the cached merge-base happens to be the OLD commit (set up via a
    // feature branch whose merge-base is oldOid).
    // A real materializing `checkout -b` would itself need to read f.txt's
    // (missing) blob to populate the working tree, firing the canary during
    // TEST SETUP via the unhardened fixture env — before the hardened
    // service is even exercised. Moving HEAD via branch+symbolic-ref instead
    // changes the "current branch" (so resolveBase's local-`main`-candidate
    // + merge-base(candidate, headOid) still yields oldOid, exactly as a
    // real checkout would) without ever touching the missing blob.
    git(root, ['branch', 'feature', oldOid])
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/feature'])
    writeFile(root, 'g.txt', 'untracked change on feature\n')
    const capture2 = captureRunnerArgv(gitService)
    let status
    try {
      status = await repoService.getStatus(root, [], 'branch')
    } finally {
      capture2.restore()
    }
    expect(status.repo.state).toBe('git')
    // Fix #134: liveness alone ("didn't crash") doesn't prove the degrade
    // path does the RIGHT thing — TRD §7.2 row 10 requires this exact
    // correctness assertion.
    expect(status.totals.approximate).toBe(true)
    expect(marker.exists()).toBe(false)

    // Fix #134: the sanity-check readBlob above (baseline 'head') only ever
    // touches the present v2 blob. The actual missing-object contract is
    // readBlob's 'branch' baseline against oldOid's tree, where f.txt really
    // is unreachable — assert it resolves to 'unavailable', not just that it
    // doesn't throw.
    const branchBlob = await repoService.readBlob(root, [], 'branch', 'f.txt', undefined)
    expect(branchBlob.kind).toBe('unavailable')
    expect(marker.exists()).toBe(false)

    replayUntilFired([...capture.calls, ...capture2.calls], marker)
  })
})

describe('canary 11 (C1) — blob-less partial clone, remote.origin.uploadpack override', () => {
  it('readBaseline/getStatus stay live and marker-free; replay via the uploadpack override proves the vector', async () => {
    const { clone: root, oldOid } = makePartialCloneWithMissingBlob()
    const marker = plantMarker(root, 11)
    git(root, ['config', 'remote.origin.uploadpack', `touch ${marker.path}; git-upload-pack`])
    git(root, ['config', 'protocol.file.allow', 'always'])

    const { gitService, repoService } = makeCanaryService()
    // readBlob reuses the cache populated by a prior getRepoInfo/getStatus
    // call (it never probes on its own) — prime it first.
    await repoService.getRepoInfo(root, [])
    const capture = captureRunnerArgv(gitService)
    try {
      const blob = await repoService.readBlob(root, [], 'head', 'f.txt', undefined)
      expect(blob.kind).toBe('text')
    } finally {
      capture.restore()
    }
    expect(marker.exists()).toBe(false)

    // A real materializing `checkout -b` would itself need to read f.txt's
    // (missing) blob to populate the working tree, firing the canary during
    // TEST SETUP via the unhardened fixture env — before the hardened
    // service is even exercised. Moving HEAD via branch+symbolic-ref instead
    // changes the "current branch" (so resolveBase's local-`main`-candidate
    // + merge-base(candidate, headOid) still yields oldOid, exactly as a
    // real checkout would) without ever touching the missing blob.
    git(root, ['branch', 'feature', oldOid])
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/feature'])
    const capture2 = captureRunnerArgv(gitService)
    let status
    try {
      status = await repoService.getStatus(root, [], 'branch')
    } finally {
      capture2.restore()
    }
    expect(status.repo.state).toBe('git')
    // Fix #134: liveness alone ("didn't crash") doesn't prove the degrade
    // path does the RIGHT thing — TRD §7.2 row 10 requires this exact
    // correctness assertion.
    expect(status.totals.approximate).toBe(true)
    expect(marker.exists()).toBe(false)

    // Fix #134: the sanity-check readBlob above (baseline 'head') only ever
    // touches the present v2 blob. The actual missing-object contract is
    // readBlob's 'branch' baseline against oldOid's tree, where f.txt really
    // is unreachable — assert it resolves to 'unavailable', not just that it
    // doesn't throw.
    const branchBlob = await repoService.readBlob(root, [], 'branch', 'f.txt', undefined)
    expect(branchBlob.kind).toBe('unavailable')
    expect(marker.exists()).toBe(false)

    replayUntilFired([...capture.calls, ...capture2.calls], marker)
  })
})

// ---------------------------------------------------------------------------
// Canary 12 (H3) — untracked FIFOs and a /dev/zero symlink: getStatus stays
// bounded, approximate:true, and the libuv thread pool is never parked.
// ---------------------------------------------------------------------------

describe('canary 12 (H3) — untracked FIFO / /dev/zero symlinks', () => {
  it.skipIf(process.platform === 'win32')(
    'getStatus completes with approximate:true, and a concurrent readFile is never blocked',
    async () => {
      const root = tmpDir()
      makeRepo(root)
      const { repoService } = makeCanaryService()

      let fifosAvailable = true
      for (let i = 0; i < 5; i++) {
        try {
          execFileSync('mkfifo', [path.join(root, `fifo${i}`)])
        } catch {
          fifosAvailable = false
          break
        }
      }
      if (!fifosAvailable) return // mkfifo unavailable on this platform — skip
      fs.symlinkSync('/dev/zero', path.join(root, 'zero-link'))

      const st = fs.lstatSync(path.join(root, 'fifo0'))
      expect(st.isFIFO()).toBe(true) // hand-written precondition (§D-9)

      const otherFile = path.join(root, 'other.txt')
      fs.writeFileSync(otherFile, 'x')

      const start = Date.now()
      const [status, otherContent] = await Promise.all([
        repoService.getStatus(root, [], 'head'),
        fs.promises.readFile(otherFile, 'utf-8'),
      ])
      const elapsed = Date.now() - start

      expect(otherContent).toBe('x') // the thread pool was never parked on a FIFO/dev read
      expect(elapsed).toBeLessThan(1000)
      expect(status.repo.state).toBe('git')
      expect(status.totals.approximate).toBe(true)
    },
    10_000,
  )
})

// ---------------------------------------------------------------------------
// Canary 13 (M1) — a driver added to .git/config between the pre- and
// post-enumeration: status() -> git-unsafe, results discarded.
// ---------------------------------------------------------------------------

describe('canary 13 (M1) — driver added mid-status', () => {
  it('the re-enumeration detects the drift and discards the results', async () => {
    const root = tmpDir()
    makeRepo(root)
    const { repoService } = makeCanaryService()
    const configPath = path.join(root, '.git', 'config')

    const result = await repoService.getStatus(root, [], 'head', {
      onBetweenEnumerations: () => {
        fs.appendFileSync(configPath, '[filter "injected-mid-status"]\n\tclean = would-run-here\n')
      },
    })
    expect(result.repo.state).toBe('git-unsafe')
    expect(result.changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Hermetic guard test (H1)
// ---------------------------------------------------------------------------

describe('hermetic guard (H1)', () => {
  it('a hostile .gitconfig at the position the developer\'s real HOME would occupy has no effect once baseEnvOverrides isolates HOME elsewhere', async () => {
    // Never writes to the actual os.homedir() — "fakeRealHome" is a tmp dir
    // standing in for that position, so this proof never touches the real
    // developer's or CI runner's machine.
    const fakeRealHome = tmpDir('co-canary-realhome-')
    const marker = plantMarker(fakeRealHome, 'guard')
    fs.writeFileSync(path.join(fakeRealHome, '.gitconfig'), `[core]\n\tfsmonitor = ${marker.touchCmd}\n`)

    const root = tmpDir()
    makeRepo(root)

    // Precondition: the hostile config IS live for a caller that (unlike the
    // service) actually uses fakeRealHome as HOME with no isolation.
    rawGit(root, ['status'], { ...hermeticEnv(), HOME: fakeRealHome, XDG_CONFIG_HOME: path.join(fakeRealHome, '.config') })
    if (!marker.exists()) throw new Error('canary precondition not met')
    marker.clear()

    // The service, configured with baseEnvOverrides pointing HOME elsewhere
    // (and GIT_CONFIG_NOSYSTEM=1), never reads it.
    const { repoService } = makeCanaryService()
    const info = await repoService.getRepoInfo(root, [])
    expect(info.state).toBe('git')
    expect(marker.exists()).toBe(false)
  })
})
