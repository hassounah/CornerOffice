import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import { dockerOk, docker, makeIdentity, removeIdentity, buildTestImage, removeTestImage, createSandboxRig, agentSh } from './helpers'
import type { TestIdentity, SandboxRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'
import { status } from '../../main/services/sandbox-worktree'
import { git } from '../helpers/git-fixtures'

// ---------------------------------------------------------------------------
// git-overlays.test.ts (TRD §7.2 #2, #11, #12, #13; C2, H3, M2) — the
// read-only overlays on the shared `.git`, against a container created from
// the REAL mount plan (planMounts + createArgv) over a real worktree. Every
// "write fails" assertion has a positive control in the same container (a
// write to a read-write path succeeds), so a container that is read-only
// everywhere can't pass vacuously.
// ---------------------------------------------------------------------------

const EROFS = /Read-only file system/i

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('git overlays — TRD §7.2 #2, #11, #12, #13', () => {
  let d: DockerRunner
  let identity: TestIdentity
  let rig: SandboxRig

  const sh = (script: string, env?: Record<string, string>) => agentSh(d, rig, identity, script, env)

  async function expectErofs(script: string): Promise<void> {
    const result = await sh(script)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(EROFS)
  }

  beforeAll(async () => {
    d = docker()
    identity = makeIdentity()
    await buildTestImage(d, identity)
    rig = await createSandboxRig(d, identity, { otherWorktrees: ['other'] })
  }, 5 * 60_000)

  afterAll(async () => {
    if (rig) await rig.cleanup()
    await removeTestImage(d)
    if (identity) removeIdentity(identity)
  }, 60_000)

  it('control: the agent can write inside the worktree and to refs in the shared .git', async () => {
    const result = await sh(`touch "$WT/control.txt" && mkdir -p "$REPO/.git/refs/heads/ctl" && touch "$REPO/.git/refs/heads/ctl/x"`, { WT: rig.wt, REPO: rig.repo })
    expect(result.exitCode).toBe(0)
  })

  describe('§7.2 #2 — hooks and config are read-only; commits still work', () => {
    it('writing $REPO/.git/hooks/x fails with EROFS', async () => {
      await expectErofs(`echo '#!/bin/sh' > "${path.join(rig.repo, '.git', 'hooks', 'x')}"`)
    })

    it('writing $REPO/.git/config fails with EROFS', async () => {
      await expectErofs(`echo '[core]' >> "${path.join(rig.repo, '.git', 'config')}"`)
    })

    it('a commit in $WT succeeds and is visible from host git', async () => {
      const env = { GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'a@x.invalid', GIT_COMMITTER_NAME: 'Agent', GIT_COMMITTER_EMAIL: 'a@x.invalid' }
      const result = await sh('git switch -c feat/overlay-check && git commit --allow-empty -q -m "from the sandbox"', env)
      expect(result.exitCode).toBe(0)

      expect(git(rig.repo, ['log', '--format=%s', '-1', 'feat/overlay-check']).trim()).toBe('from the sandbox')
    })
  })

  describe('§7.2 #11 — the worktree pointer files are read-only (C2)', () => {
    it('writing $WT/.git fails with EROFS', async () => {
      await expectErofs(`echo x >> "${path.join(rig.wt, '.git')}"`)
    })

    it('writing the worktree gitdir and commondir files fails with EROFS', async () => {
      await expectErofs(`echo x >> "${path.join(rig.gwt, 'gitdir')}"`)
      await expectErofs(`echo x >> "${path.join(rig.gwt, 'commondir')}"`)
    })

    it('host-side pinned status still works afterwards', async () => {
      const result = await status(rig.gitService, rig.wtCtx, 'main')
      expect(result.headShort).toMatch(/^[0-9a-f]{4,40}$/)
    })
  })

  describe('§7.2 #12 — the main checkout index and HEAD are read-only (H3)', () => {
    it('writing $REPO/.git/index fails with EROFS', async () => {
      await expectErofs(`echo x >> "${path.join(rig.repo, '.git', 'index')}"`)
    })

    it('writing $REPO/.git/HEAD fails with EROFS', async () => {
      await expectErofs(`echo x >> "${path.join(rig.repo, '.git', 'HEAD')}"`)
    })

    it("writing another worktree's index fails with EROFS (the G1 .git/worktrees overlay)", async () => {
      await expectErofs(`echo x >> "${path.join(rig.repo, '.git', 'worktrees', 'other', 'index')}"`)
    })

    it("the sandbox's own worktree admin directory stays writable (its index is the agent's)", async () => {
      const result = await sh(`touch "${path.join(rig.gwt, 'agent-writable')}"`)
      expect(result.exitCode).toBe(0)
    })
  })

  describe('§7.2 #13 — .git/modules is read-only even when the repo had none (M2)', () => {
    it('the repo had no .git/modules before the rig pre-created the empty mount target', () => {
      expect(rig.modulesWasAbsent).toBe(true)
    })

    it('mkdir $REPO/.git/modules/x fails with EROFS', async () => {
      await expectErofs(`mkdir "${path.join(rig.repo, '.git', 'modules', 'x')}"`)
    })
  })
})
