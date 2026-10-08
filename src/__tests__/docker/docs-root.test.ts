import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { dockerOk, docker, makeIdentity, removeIdentity, buildTestImage, removeTestImage, createSandboxRig, agentSh } from './helpers'
import type { TestIdentity, SandboxRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'

// ---------------------------------------------------------------------------
// docs-root.test.ts (#0035) — an in-repo docs_root is the HOST directory at
// both $REPO/<rel> and $WT/<rel>. A write through the cwd-relative path (the
// container cwd is $WT) must land in the host docs_root, not in the worktree.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('docs_root — #0035', () => {
  let d: DockerRunner
  let identity: TestIdentity
  const rigs: SandboxRig[] = []

  beforeAll(async () => {
    d = docker()
    identity = makeIdentity()
    await buildTestImage(d, identity)
  }, 5 * 60_000)

  afterAll(async () => {
    for (const rig of rigs) await rig.cleanup()
    await removeTestImage(d)
    if (identity) removeIdentity(identity)
  }, 60_000)

  it.each([
    ['docs', 'x'],
    [path.join('notes', 'docs'), 'y'],
  ])('a write to <cwd>/%s/%s lands in the host docs_root, not the worktree', async (docsRel, file) => {
    const rig = await createSandboxRig(d, identity, { docsRel })
    rigs.push(rig)

    const result = await agentSh(d, rig, identity, `echo hi > ${docsRel}/${file}`)

    expect(result.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(rig.repo, docsRel, file), 'utf8')).toBe('hi\n')
    // Control: the worktree's own directory stayed empty, so the write went through the mount.
    expect(fs.existsSync(path.join(rig.wt, docsRel, file))).toBe(false)
  }, 2 * 60_000)

  it('a tracked docs_root: the write lands in the host checkout, the worktree copy stays the committed one', async () => {
    const rig = await createSandboxRig(d, identity, { docsRel: 'docs', docsTracked: true })
    rigs.push(rig)

    const result = await agentSh(d, rig, identity, 'echo hi > docs/x')

    expect(result.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(rig.repo, 'docs', 'x'), 'utf8')).toBe('hi\n')
    expect(fs.existsSync(path.join(rig.wt, 'docs', 'x'))).toBe(false)
    expect(fs.readFileSync(path.join(rig.wt, 'docs', 'seed.md'), 'utf8')).toBe('seed\n')
  }, 2 * 60_000)
})
