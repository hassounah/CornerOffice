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
// an image built with sandbox.extraPackages, a profile home created next to the real mounts, and
// the egress allowlist for the Electron download hosts. Needs Docker and
// network; run via `CO_DOCKER_TESTS=1 pnpm test:docker`. D1 (ldd) and D2 also
// need an unpacked Electron: set CO_ELECTRON_DIST to its directory (the one
// holding the `electron` binary), as the host spike (spike-2.1.sh) does.
// ---------------------------------------------------------------------------

const ELECTRON_DIST = process.env.CO_ELECTRON_DIST ?? ''
const HAS_ELECTRON = ELECTRON_DIST !== '' && fs.existsSync(path.join(ELECTRON_DIST, 'electron'))
const DEBUG_PORT = 9222
// The package list `make dev` prints for sandbox.extraPackages (scripts/co_dev_sandbox.sh ELECTRON_PACKAGES).
const ELECTRON_PACKAGES = [
  'xvfb', 'glib', 'nss', 'nspr', 'atk', 'at-spi2-core', 'cups-libs', 'dbus-libs', 'libdrm', 'libxkbcommon', 'libxcomposite',
  'libxdamage', 'libxfixes', 'libxrandr', 'mesa-gbm', 'pango', 'cairo', 'alsa-lib', 'gtk-3', 'fontconfig', 'font-dejavu',
]

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
      toolchains: { node: false, go: false, buildBase: false, extraPackages: ELECTRON_PACKAGES },
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

  describe('D1 — image with the Electron extraPackages', () => {
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

    const HOSTS = ['electronjs.org', 'release-assets.githubusercontent.com']

    it('refuses the Electron download hosts until the workspace allowlist lists them', async () => {
      for (const host of HOSTS) expect(await dnsStatus(host)).toBe('REFUSED')

      await d.run(firewallInitArgv(electron.name, 'allowlist'), {
        stdin: [...DEFAULT_ALLOWLIST, ...HOSTS].join('\n'),
        timeoutMs: 30_000,
      })

      for (const host of HOSTS) expect(await dnsStatus(host)).not.toBe('REFUSED')
    })
  })
})
