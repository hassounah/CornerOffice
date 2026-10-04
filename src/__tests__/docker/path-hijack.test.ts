import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { dockerOk, docker, makeIdentity, removeIdentity, buildTestImage, createTestContainer, removeTestContainer, removeTestImage, execAsArgv } from './helpers'
import type { TestIdentity, TestContainer } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'
import { firewallInitArgv, blockedPollArgv } from '../../main/services/sandbox-spec'
import { DEFAULT_ALLOWLIST } from '../../main/services/sandbox-allowlist'

// ---------------------------------------------------------------------------
// path-hijack.test.ts (TRD §7.2 #10, C1) — plants executable marker scripts
// named after every absolute binary the entrypoint/firewall/poll rely on, in
// the ONE place the agent's own PATH searches first ($HOME/.local/bin), then
// proves none of them ever run: co-entrypoint.sh (via restart),
// init-firewall.sh (root exec) and the codns Blocked poll each pin their own
// PATH before anything else runs, so a hijacked binary sitting where only
// the agent's *own* session PATH would find it is never consulted.
// ---------------------------------------------------------------------------

const MARKER_NAMES = ['sleep', 'tail', 'dig', 'pkill', 'iptables', 'ipset', 'dnsmasq']

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('C1 PATH hijack — TRD §7.2 #10', () => {
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

  it('no hijacked binary in $HOME/.local/bin ever runs across a restart, a firewall init and a Blocked poll', async () => {
    // 1. Plant marker scripts under $HOME/.local/bin — the one place the
    // AGENT's own PATH (baked into the image: `${AGENT_HOME}/.local/bin:...`)
    // searches first. Each script, if ever run, touches a marker file.
    const plant = [
      'mkdir -p "$HOME/.local/bin" "$HOME/markers"',
      ...MARKER_NAMES.map(
        (name) => `printf '#!/bin/sh\\ntouch "$HOME/markers/${name}"\\n' > "$HOME/.local/bin/${name}" && chmod +x "$HOME/.local/bin/${name}"`,
      ),
    ].join(' && ')
    await d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', plant]))

    // Positive control: the plant is real. The agent's own PATH resolves every
    // planted name to the hijacked script, and running one fires its marker.
    // Without this, "0 markers" below would also pass for a mis-planted script.
    for (const name of MARKER_NAMES) {
      const resolved = await d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', `command -v ${name}`]))
      expect(resolved.stdout.trim()).toBe(`${identity.home}/.local/bin/${name}`)
    }
    await d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', 'tail']))
    const fired = await d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', 'ls "$HOME/markers"']))
    expect(fired.stdout.trim()).toBe('tail')
    await d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', 'rm -f "$HOME/markers/tail"']))

    // 2. Restart — reruns co-entrypoint.sh (pins PATH=/usr/bin:/bin first).
    await d.run(['restart', container.name], { timeoutMs: 30_000 })

    // 3. Firewall init as root — pins its own PATH first, absolute binaries throughout.
    await d.run(firewallInitArgv(container.name, 'allowlist'), {
      stdin: [...DEFAULT_ALLOWLIST].join('\n'),
      timeoutMs: 30_000,
    })

    // 4. One Blocked poll as codns — pinned PATH=/usr/bin:/bin, absolute /usr/bin/tail.
    await d.run(blockedPollArgv(container.name, 0), { timeoutMs: 10_000 })

    // 5. No marker file exists — none of the hijacked scripts ever ran.
    const result = await d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', 'ls "$HOME/markers" 2>/dev/null | wc -l']))
    expect(result.stdout.trim()).toBe('0')
  })
})
