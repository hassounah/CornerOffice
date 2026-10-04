import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  dockerOk,
  docker,
  makeIdentity,
  removeIdentity,
  buildTestImage,
  createTestContainer,
  removeTestContainer,
  removeTestImage,
  execAsArgv,
  execAsRootArgv,
} from './helpers'
import type { TestIdentity, TestContainer } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'

// ---------------------------------------------------------------------------
// image.test.ts (TRD §7.2 #1) — UID mapping, no sudo, no setuid files.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('sandbox image — TRD §7.2 #1', () => {
  let d: DockerRunner
  let identity: TestIdentity
  let container: TestContainer

  beforeAll(async () => {
    d = docker()
    identity = makeIdentity()
    await buildTestImage(d, identity)
    container = await createTestContainer(d, identity)
  }, 5 * 60_000)

  afterAll(async () => {
    if (container) await removeTestContainer(d, container.name)
    await removeTestImage(d)
    if (identity) removeIdentity(identity)
  }, 60_000)

  it('the agent uid inside the container equals the host uid', async () => {
    const result = await d.run(execAsArgv(container.name, identity, ['id', '-u']))
    expect(result.stdout.trim()).toBe(String(identity.uid))
  })

  it('the agent gid inside the container equals the host gid', async () => {
    const result = await d.run(execAsArgv(container.name, identity, ['id', '-g']))
    expect(result.stdout.trim()).toBe(String(identity.gid))
  })

  it('sudo is not installed', async () => {
    await expect(
      d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', 'command -v sudo'])),
    ).rejects.toThrow()
  })

  it('no setuid/setgid files exist anywhere on the image (the Dockerfile strip worked)', async () => {
    // Root, because a non-root `find / -xdev` hits permission-denied noise on
    // unrelated system paths that would drown out the actual assertion.
    const result = await d.run(execAsRootArgv(container.name, ['find', '/', '-xdev', '-perm', '/6000', '-type', 'f']))
    expect(result.stdout.trim()).toBe('')
  })

  it('$HOME/.corner-office/{sandboxes,events} are pre-created and agent-owned (TRD §14.6 #13)', async () => {
    // Docker creates a missing mount-target parent directory as root — these
    // two are the parents of every worktree/events mount target planMounts
    // builds, so they must already exist, agent-owned, before any mount.
    for (const dir of ['.corner-office', '.corner-office/sandboxes', '.corner-office/events']) {
      const result = await d.run(execAsArgv(container.name, identity, ['stat', '-c', '%u:%g', `${identity.home}/${dir}`]))
      expect(result.stdout.trim()).toBe(`${identity.uid}:${identity.gid}`)
    }
  })
})
