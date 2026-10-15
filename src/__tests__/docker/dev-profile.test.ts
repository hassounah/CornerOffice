import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  dockerOk,
  docker,
  makeIdentity,
  removeIdentity,
  buildTestImage,
  createTestContainer,
  testPort,
  createSandboxRig,
  removeTestContainer,
  removeTestImage,
  execAsArgv,
  agentSh,
  ELECTRON_TEST_IMAGE,
} from './helpers'
import type { TestIdentity, TestContainer, SandboxRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'
import { firewallInitArgv } from '../../main/services/sandbox-spec'
import { DEFAULT_ALLOWLIST } from '../../main/services/sandbox-allowlist'

// ---------------------------------------------------------------------------
// dev-profile.test.ts (#0038 TRD §7.2 D1-D4) — the in-sandbox dev instance:
// the WITH_ELECTRON image, a profile home created next to the real mounts, and
// the egress allowlist for the Electron download hosts. Needs Docker and
// network (D4 is the Dev app access publish, 3a); run via `CO_DOCKER_TESTS=1 pnpm test:docker`. D1 (ldd) and D2 also
// need an unpacked Electron: set CO_ELECTRON_DIST to its directory (the one
// holding the `electron` binary), as the host spike (spike-2.1.sh) does.
// ---------------------------------------------------------------------------

const ELECTRON_DIST = process.env.CO_ELECTRON_DIST ?? ''
const HAS_ELECTRON = ELECTRON_DIST !== '' && fs.existsSync(path.join(ELECTRON_DIST, 'electron'))
const DEBUG_PORT = 9222

/** Runs `script` with `sh -c` as the agent in `container`; tolerates a failing exit so the caller can assert it. */
function shAsAgent(d: DockerRunner, container: TestContainer, identity: TestIdentity, script: string, env: Record<string, string> = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])
  const argv = execAsArgv(container.name, identity, ['/bin/sh', '-c', script])
  argv.splice(3, 0, ...envArgs)
  return d.run(argv, { allowExit: [1, 2, 126, 127], timeoutMs: 60_000 })
}

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('dev profile — #0038 TRD §7.2 D1-D3', () => {
  let d: DockerRunner
  let identity: TestIdentity
  let electron: TestContainer
  let rig: SandboxRig

  beforeAll(async () => {
    d = docker()
    identity = makeIdentity()
    await buildTestImage(d, identity, {
      image: ELECTRON_TEST_IMAGE,
      toolchains: { node: false, go: false, buildBase: false, electron: true },
    })
    const mountFlags = HAS_ELECTRON ? ['--mount', `type=bind,src=${ELECTRON_DIST},dst=/opt/electron,readonly`] : []
    electron = await createTestContainer(d, identity, { image: ELECTRON_TEST_IMAGE, extraCreateFlags: mountFlags })
    await d.run(firewallInitArgv(electron.name, 'allowlist'), { stdin: [...DEFAULT_ALLOWLIST].join('\n'), timeoutMs: 30_000 })

    // The standard mounts (events/<slug>, sandboxes/<slug>) on the plain test image, for the profile-home check.
    await buildTestImage(d, identity)
    rig = await createSandboxRig(d, identity)
  }, 10 * 60_000)

  afterAll(async () => {
    if (rig) await rig.cleanup()
    if (electron) await removeTestContainer(d, electron.name)
    if (d) {
      await removeTestImage(d, ELECTRON_TEST_IMAGE)
      await removeTestImage(d)
    }
    if (identity) removeIdentity(identity)
  }, 120_000)

  describe('D1 — WITH_ELECTRON image', () => {
    it('has no setuid or setgid files', async () => {
      const result = await d.run(['exec', '--user', 'root', electron.name, 'find', '/', '-xdev', '-perm', '/6000', '-type', 'f'])
      expect(result.stdout.trim()).toBe('')
    })

    it('starts Xvfb as the agent uid', async () => {
      const result = await shAsAgent(
        d,
        electron,
        identity,
        'Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & pid=$!; sleep 2; kill -0 "$pid" && stat -c %u /proc/$pid; kill "$pid"',
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(String(identity.uid))
    })

    it.skipIf(!HAS_ELECTRON)('ldd reports no missing libraries for the Electron binary', async () => {
      const result = await shAsAgent(d, electron, identity, 'ldd /opt/electron/electron')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('not found')
    })

    it('creates profiles/dev with mode 0700 and leaves ~/.corner-office and the mounts alone', async () => {
      const root = path.join(identity.home, '.corner-office')
      const modeOf = async (p: string): Promise<string> => (await agentSh(d, rig, identity, `stat -c %a ${p}`)).stdout.trim()
      const parentBefore = await modeOf(root)
      const eventsBefore = await modeOf(rig.containerEventsDir)
      const sandboxesBefore = await modeOf(rig.paths.sandboxesRoot)

      const made = await agentSh(
        d,
        rig,
        identity,
        `bun -e "require('fs').mkdirSync('${root}/profiles/dev', { recursive: true, mode: 0o700 })"`,
      )
      expect(made.exitCode).toBe(0)

      expect(await modeOf(`${root}/profiles/dev`)).toBe('700')
      expect(await modeOf(root)).toBe(parentBefore)
      expect(await modeOf(rig.containerEventsDir)).toBe(eventsBefore)
      expect(await modeOf(rig.paths.sandboxesRoot)).toBe(sandboxesBefore)
      // The profile lives on the container's own filesystem, never on a host mount.
      expect(fs.existsSync(path.join(rig.paths.eventsRoot, 'profiles'))).toBe(false)
      expect(fs.existsSync(path.join(root, 'profiles'))).toBe(false)
    })
  })

  describe('D2 — Electron under Xvfb', () => {
    it.skipIf(!HAS_ELECTRON)('answers /json/version on 127.0.0.1 inside the container', async () => {
      const script = [
        'Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &',
        `DISPLAY=:99 /opt/electron/electron --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=${DEBUG_PORT} about:blank >/tmp/electron.log 2>&1 &`,
        `for i in $(seq 1 30); do curl -s --max-time 2 http://127.0.0.1:${DEBUG_PORT}/json/version && exit 0; sleep 1; done`,
        'cat /tmp/electron.log; exit 1',
      ].join('\n')
      const result = await shAsAgent(d, electron, identity, script)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toHaveProperty('Browser')
    }, 90_000)
  })

  describe('D3 — firewall and the Electron download hosts', () => {
    async function dnsStatus(name: string): Promise<string> {
      const result = await d.run(execAsArgv(electron.name, identity, ['dig', '+time=3', '+tries=1', '+noall', '+comments', '@127.0.0.1', 'A', name]))
      const match = /status: ([A-Z]+)/.exec(result.stdout)
      if (!match) throw new Error('dig produced no status line')
      return match[1]
    }

    it('forwards release-assets.githubusercontent.com from the default allowlist', async () => {
      expect(await dnsStatus('release-assets.githubusercontent.com')).not.toBe('REFUSED')
    })

    it('refuses electronjs.org until the workspace allowlist lists it', async () => {
      expect(await dnsStatus('electronjs.org')).toBe('REFUSED')

      await d.run(firewallInitArgv(electron.name, 'allowlist'), {
        stdin: [...DEFAULT_ALLOWLIST, 'electronjs.org'].join('\n'),
        timeoutMs: 30_000,
      })

      expect(await dnsStatus('electronjs.org')).not.toBe('REFUSED')
    })
  })

  describe('D4 — Dev app access: CDP published on 127.0.0.1 through socat', () => {
    let cdp: TestContainer
    let cdpPort: number
    let gateway: string

    /** The default route's gateway from /proc/net/route (little-endian hex), as the launcher's parse_gw reads it. */
    function parseGateway(route: string): string {
      for (const line of route.split('\n').slice(1)) {
        const [, dest, gw] = line.trim().split(/\s+/)
        if (dest === '00000000' && /^[0-9A-Fa-f]{8}$/.test(gw)) {
          return [6, 4, 2, 0].map((i) => parseInt(gw.slice(i, i + 2), 16)).join('.')
        }
      }
      throw new Error('no default route in the container')
    }

    beforeAll(async () => {
      cdpPort = testPort()
      cdp = await createTestContainer(d, identity, { image: ELECTRON_TEST_IMAGE, cdpPort })
      gateway = parseGateway((await d.run(['exec', cdp.name, 'cat', '/proc/net/route'])).stdout)
      // A stand-in for the dev app's CDP endpoint, then the launcher's socat, limited to the gateway.
      const script = [
        `bun -e "Bun.serve({ hostname: '127.0.0.1', port: ${DEBUG_PORT}, fetch: () => new Response('{\\"Browser\\":\\"stand-in\\"}') })" >/tmp/cdp-server.log 2>&1 &`,
        `socat -d -d TCP-LISTEN:${cdpPort},bind=0.0.0.0,fork,reuseaddr,range=${gateway}/32 TCP:127.0.0.1:${DEBUG_PORT} >/tmp/socat.log 2>&1 &`,
        'sleep 1',
      ].join('\n')
      await d.run(['exec', '--detach', '--user', `${identity.uid}:${identity.gid}`, cdp.name, '/bin/sh', '-c', script])
    }, 5 * 60_000)

    afterAll(async () => {
      if (cdp) await removeTestContainer(d, cdp.name)
    }, 30_000)

    it('docker port shows only 127.0.0.1 bindings, including the CDP port', async () => {
      const lines = (await d.run(['port', cdp.name])).stdout.trim().split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
      for (const line of lines) expect(line).toMatch(/-> 127\.0\.0\.1:\d+$/)
      expect(lines.some((l) => l.endsWith(`127.0.0.1:${cdpPort}`))).toBe(true)
    })

    it('the host reaches /json/version through socat, and socat saw the gateway as the source', async () => {
      let body = ''
      for (let attempt = 0; attempt < 20 && body === ''; attempt++) {
        try {
          body = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2_000) })).text()
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      expect(body).toContain('stand-in')

      const log = (await d.run(['exec', cdp.name, 'cat', '/tmp/socat.log'])).stdout
      expect(log).toContain(`accepting connection from AF=2 ${gateway}`)
    })

    it('a second bridge container is refused', async () => {
      const ip = (await d.run(['inspect', '-f', '{{.NetworkSettings.IPAddress}}', cdp.name])).stdout.trim()
      expect(ip).not.toBe('')
      const peer = await d.run(
        ['run', '--rm', '--entrypoint', 'curl', ELECTRON_TEST_IMAGE, '-sS', '--max-time', '5', `http://${ip}:${cdpPort}/json/version`],
        { allowExit: [1, 7, 28, 52, 56], timeoutMs: 60_000 },
      )
      expect(peer.exitCode).not.toBe(0)
      expect(peer.stdout).not.toContain('stand-in')
    })
  })
})
