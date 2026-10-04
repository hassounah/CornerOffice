import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { dockerOk, docker, makeIdentity, removeIdentity, buildTestImage, removeTestImage, createSandboxRig } from './helpers'
import type { TestIdentity, SandboxRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'
import { stopArgv, STOP_TIMEOUT_S } from '../../main/services/sandbox-spec'

// ---------------------------------------------------------------------------
// lifecycle.test.ts (TRD §7.2 #8) — `docker stop` reaches the process the app
// exec'd. A stand-in for `claude` (the test image has no Claude Code login or
// network policy to run it): an exec'd shell that traps TERM and writes a
// marker into the mounted events directory, where the host can read it. The
// path under test is the real one: docker stop → docker-init → the entrypoint
// trap → TERM to every process in the container.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('lifecycle — TRD §7.2 #8', () => {
  let d: DockerRunner
  let identity: TestIdentity
  let rig: SandboxRig

  beforeAll(async () => {
    d = docker()
    identity = makeIdentity()
    await buildTestImage(d, identity)
    rig = await createSandboxRig(d, identity)
  }, 5 * 60_000)

  afterAll(async () => {
    if (rig) await rig.cleanup()
    await removeTestImage(d)
    if (identity) removeIdentity(identity)
  }, 60_000)

  it('docker stop delivers TERM to the exec\'d process (trap marker written)', async () => {
    const marker = path.join(rig.eventsDir, 'got-term')
    const ready = path.join(rig.eventsDir, 'ready')
    // `wait` returns as soon as a trapped signal arrives, so the trap runs promptly.
    const script = `trap 'touch "${marker}"; exit 0' TERM; touch "${ready}"; sleep 300 & wait`
    await d.run(['exec', '--detach', '--user', `${identity.uid}:${identity.gid}`, rig.container.name, '/bin/sh', '-c', script])

    // Control: the process is up and the marker doesn't exist yet.
    for (let i = 0; i < 40 && !fs.existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 250))
    expect(fs.existsSync(ready)).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)

    await d.run(stopArgv(rig.container.name, STOP_TIMEOUT_S.endSession), { timeoutMs: 30_000 })

    expect(fs.existsSync(marker)).toBe(true)
    const state = await d.run(['inspect', '--format', '{{.State.Status}}', rig.container.name])
    expect(state.stdout.trim()).toBe('exited')
  })
})
