import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { dockerOk, docker, makeIdentity, removeIdentity, buildTestImage, removeTestImage, createSandboxRig, agentSh } from './helpers'
import type { TestIdentity, SandboxRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'
import { EventParserService } from '../../main/services/event-parser'
import { EventRotatorService } from '../../main/services/event-rotator'

vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

// ---------------------------------------------------------------------------
// readers.test.ts (TRD §7.2 #15, H2 through the mount) — the agent owns the
// mounted events directory, so it can replace an events file with a symlink to
// a host file or with a FIFO. The host's readers (event-parser, event-rotator)
// are pointed at that directory and must neither block nor follow the link.
// ---------------------------------------------------------------------------

// Over the rotator's 10 MB threshold, so a reader that followed the link would rotate (rename) the host file.
const OVER_ROTATION_THRESHOLD = 10 * 1024 * 1024 + 1024
const EVENT_LINE = JSON.stringify({ timestamp: '2026-10-03T10:00:00Z', event: 'SessionStart', workspace: 'ws', sessionId: 's1', data: {} })

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('readers through the mount — TRD §7.2 #15', () => {
  let d: DockerRunner
  let identity: TestIdentity
  let rig: SandboxRig
  let hostFile: string
  const parser = new EventParserService()

  beforeAll(async () => {
    d = docker()
    identity = makeIdentity()
    await buildTestImage(d, identity)
    rig = await createSandboxRig(d, identity)
    // A host file outside every mount, holding a valid event: if a reader follows a link to it, events appear.
    hostFile = path.join(path.dirname(rig.repo), 'host-secret.jsonl')
    fs.writeFileSync(hostFile, Buffer.concat([Buffer.from(EVENT_LINE + '\n'), Buffer.alloc(OVER_ROTATION_THRESHOLD, 'x')]))
  }, 5 * 60_000)

  afterAll(async () => {
    if (rig) await rig.cleanup()
    await removeTestImage(d)
    if (identity) removeIdentity(identity)
  }, 60_000)

  it('control: a regular events file in the mounted directory is parsed', async () => {
    const regular = path.join(rig.eventsDir, 'regular.jsonl')
    const result = await agentSh(d, rig, identity, `printf '%s\\n' '${EVENT_LINE}' > "${regular}"`)
    expect(result.exitCode).toBe(0)

    expect(parser.parseFromOffset(regular, 0).events).toHaveLength(1)
  })

  it('a symlink the agent plants is not followed: nothing is parsed and the target is untouched', async () => {
    const link = path.join(rig.eventsDir, 'link.jsonl')
    const result = await agentSh(d, rig, identity, `ln -s "${hostFile}" "${link}"`)
    expect(result.exitCode).toBe(0)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    const before = fs.readFileSync(hostFile)

    expect(parser.parseFromOffset(link, 0)).toEqual({ events: [], newOffset: 0 })
    expect(fs.readFileSync(hostFile).equals(before)).toBe(true)
  })

  it('a FIFO the agent plants does not block the parser', async () => {
    const fifo = path.join(rig.eventsDir, 'fifo.jsonl')
    const result = await agentSh(d, rig, identity, `mkfifo "${fifo}"`)
    expect(result.exitCode).toBe(0)
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true)

    // A blocking open() would hang the whole test (and trip its timeout).
    expect(parser.parseFromOffset(fifo, 0)).toEqual({ events: [], newOffset: 0 })
  })

  it('the rotator pointed at the mounted directory skips the symlink and the FIFO, and never touches the target', async () => {
    // Control: a regular over-threshold file in the same directory IS rotated, so the pass really ran.
    const big = path.join(rig.eventsDir, 'big.jsonl')
    const made = await agentSh(d, rig, identity, `head -c ${OVER_ROTATION_THRESHOLD} /dev/zero > "${big}"`)
    expect(made.exitCode).toBe(0)
    const targetBefore = fs.readFileSync(hostFile)
    const onRotated = vi.fn()
    const realHome = process.env.HOME
    // The rotator reads <homedir>/.corner-office/events/<workspace>/*.jsonl.
    process.env.HOME = rig.home
    try {
      new EventRotatorService({ onRotated }, () => {}).runNow()
    } finally {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
    }

    expect(onRotated).toHaveBeenCalledTimes(1)
    expect(onRotated).toHaveBeenCalledWith(big)
    expect(fs.existsSync(hostFile)).toBe(true)
    expect(fs.readFileSync(hostFile).equals(targetBefore)).toBe(true)
    expect(fs.lstatSync(path.join(rig.eventsDir, 'link.jsonl')).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(rig.eventsDir, 'fifo.jsonl')).isFIFO()).toBe(true)
  })
})
