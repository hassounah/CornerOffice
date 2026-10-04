import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { dockerOk, docker, makeIdentity, removeIdentity, buildTestImage, removeTestImage, createSandboxRig, agentSh } from './helpers'
import type { TestIdentity, SandboxRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'

// ---------------------------------------------------------------------------
// channel.test.ts (TRD §7.2 #7, #9) — the channel server's published port is
// loopback-only on the host, and the card directory overlay keeps a sandbox's
// cards out of the host's real `~/.claude/channels`. Real mount plan, temp
// HOME only (never the real `~/.claude`).
// ---------------------------------------------------------------------------

async function fetchEventually(url: string, attempts = 20): Promise<string> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      return await response.text()
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError
}

function connectRefused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2_000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(true)
    })
  })
}

function externalIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('channel — TRD §7.2 #7, #9', () => {
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

  it('§7.2 #7: a server on 0.0.0.0:P inside is reachable at 127.0.0.1:P, and docker port shows only 127.0.0.1', async () => {
    const port = rig.container.port
    const script = `Bun.serve({ hostname: '0.0.0.0', port: ${port}, fetch: () => new Response('channel-ok') })`
    await d.run(['exec', '--detach', '--user', `${identity.uid}:${identity.gid}`, rig.container.name, 'bun', '-e', script])

    expect(await fetchEventually(`http://127.0.0.1:${port}/`)).toBe('channel-ok')

    const published = await d.run(['port', rig.container.name])
    const lines = published.stdout.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toContain(`127.0.0.1:${port}`)
      expect(line).not.toContain('0.0.0.0')
      expect(line).not.toContain('[::]')
    }
  })

  it('§7.2 #7: the same port is not reachable on a non-loopback host address', async (ctx) => {
    const external = externalIPv4()
    if (!external) ctx.skip('this host has no external IPv4 address to probe')
    expect(await connectRefused(external as string, rig.container.port)).toBe(true)
  })

  it('§7.2 #9: a card written inside appears in the host card directory and not in the host ~/.claude/channels', async () => {
    const result = await agentSh(d, rig, identity, `echo '{"card":true}' > "$HOME/.claude/channels/card.json"`)
    expect(result.exitCode).toBe(0)

    expect(fs.readFileSync(path.join(rig.cardsDir, 'card.json'), 'utf8')).toContain('"card":true')
    expect(fs.existsSync(path.join(rig.paths.claudeDir, 'channels', 'card.json'))).toBe(false)
  })

  it('§7.2 #9 control: a file written elsewhere under $HOME/.claude lands in the temp host ~/.claude', async () => {
    const result = await agentSh(d, rig, identity, `echo ok > "$HOME/.claude/plain.txt"`)
    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(path.join(rig.paths.claudeDir, 'plain.txt'))).toBe(true)
  })
})
