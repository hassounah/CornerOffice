import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createGitService } from '../main/services/git-runner'
import type { WorktreePin } from '../main/services/git-runner'
import { createRepoService } from '../main/services/git-service'
import type { RepoTarget } from '../main/services/git-service'
import { makeTmpDir, makeSimpleRepo, writeFile, captureRunnerArgv, serviceEnvOverrides } from './helpers/git-fixtures'

// ---------------------------------------------------------------------------
// git-service-pin.test.ts — step 1.10 (TRD 1.7 part, §3.6.4, §3.10, C2).
// Proves `RepoTarget`'s pin is threaded from git-service's public methods
// into the `RepoCtx` handed to git-runner, using the real 1.9 fail-closed
// guard (checkWorktreePin) as ground truth rather than inspecting internal
// state: a root under a sandboxes-root override is refused unpinned and
// admitted only once a matching pin is threaded through. A second suite
// confirms an ordinary (non-sandbox) root's bare-string, unpinned call is
// completely unaffected (#0028 compatibility) — the acceptance target for
// `git diff --exit-code main -- git-service-*.test.ts git-canaries.test.ts`
// being empty is exercised by those existing (untouched) files themselves.
// ---------------------------------------------------------------------------

// Mirrors git-runner.test.ts's `selfPinFor` — a pin whose gitDir/commonDir/
// workTree are the plain repo's own real paths. Not a real linked-worktree
// layout (that's sandbox-worktree.ts, step 3.1+), but a correct pin for an
// ordinary repo: GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE forced to these values
// resolve exactly as an unpinned probe of the same repo would.
function selfPinFor(repo: string): WorktreePin {
  return { gitDir: path.join(repo, '.git'), commonDir: path.join(repo, '.git'), workTree: repo }
}

function makeHermeticHomes(tmpDir: string): { tmpHome: string; tmpXdg: string } {
  const tmpHome = path.join(tmpDir, 'home')
  const tmpXdg = path.join(tmpDir, 'xdg')
  fs.mkdirSync(tmpHome, { recursive: true })
  fs.mkdirSync(tmpXdg, { recursive: true })
  return { tmpHome, tmpXdg }
}

describe('git-service — RepoTarget pin threading (1.10, SEC C2)', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('unpinned string target under a sandboxes-root override fails closed; the same root as a pinned RepoTarget succeeds and its diff argv carries --ignore-submodules=all', async () => {
    tmpDir = makeTmpDir()
    const sandboxesRoot = path.join(tmpDir, 'sandboxes')
    fs.mkdirSync(sandboxesRoot, { recursive: true })
    const repo = path.join(sandboxesRoot, 'repo')
    makeSimpleRepo(repo)
    // Uncommitted change so getStatus has something to report.
    writeFile(repo, 'readme.md', '# hello\nedited\n')

    const { tmpHome, tmpXdg } = makeHermeticHomes(tmpDir)
    const gitService = createGitService({
      baseEnvOverrides: serviceEnvOverrides(tmpHome, tmpXdg),
      sandboxesRootOverride: sandboxesRoot,
    })
    const repoService = createRepoService(gitService)
    const { calls, restore } = captureRunnerArgv(gitService)

    try {
      // Bare string (the #0028 RepoTarget shape) carries no pin. `repo` lies
      // under the override sandboxes root, so the 1.9 guard rejects every
      // runGit call for it; getRepoInfo's generic catch path degrades that
      // to a non-git state rather than throwing (matches its existing
      // 'inside-workspace'/'not-found' handling for other runGit failures).
      const unpinned = await repoService.getStatus(repo, [], 'head')
      expect(unpinned.repo.state).not.toBe('git')
      expect(unpinned.changes).toEqual([])

      // Same root, now a RepoTarget with a matching pin. getStatus and
      // getRepoInfo must thread `pin` into the RepoCtx they build for this
      // to pass the 1.9 guard at all — proving the plumbing this step adds.
      const target: RepoTarget = { root: repo, pin: selfPinFor(repo) }
      const pinned = await repoService.getStatus(target, [], 'head')
      expect(pinned.repo.state).toBe('git')
      expect(pinned.changes).toEqual([expect.objectContaining({ relPath: 'readme.md', status: 'modified' })])

      const diffCalls = calls.filter((c) => c.args.includes('diff'))
      expect(diffCalls.length).toBeGreaterThan(0)
      for (const call of diffCalls) {
        expect(call.args).toContain('--ignore-submodules=all')
      }
    } finally {
      restore()
    }
  })

  it('an ordinary (non-sandbox) root keeps working as a bare, unpinned string — #0028 compatibility', async () => {
    tmpDir = makeTmpDir()
    const repo = path.join(tmpDir, 'repo')
    makeSimpleRepo(repo)
    writeFile(repo, 'readme.md', '# hello\nedited\n')

    const { tmpHome, tmpXdg } = makeHermeticHomes(tmpDir)
    // No sandboxesRootOverride: `repo` isn't under any sandboxes root, so
    // the 1.9 guard admits it unpinned — the same as every #0028 caller.
    const gitService = createGitService({ baseEnvOverrides: serviceEnvOverrides(tmpHome, tmpXdg) })
    const repoService = createRepoService(gitService)
    const { calls, restore } = captureRunnerArgv(gitService)

    try {
      const result = await repoService.getStatus(repo, [], 'head')
      expect(result.repo.state).toBe('git')
      expect(result.changes).toEqual([expect.objectContaining({ relPath: 'readme.md', status: 'modified' })])

      const diffCalls = calls.filter((c) => c.args.includes('diff'))
      expect(diffCalls.length).toBeGreaterThan(0)
      for (const call of diffCalls) {
        expect(call.args).toContain('--ignore-submodules=all')
      }
    } finally {
      restore()
    }
  })
})
