import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import dns from 'dns'
import net from 'net'
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
} from './helpers'
import type { TestIdentity, TestContainer } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'
import { firewallInitArgv, blockedPollArgv } from '../../main/services/sandbox-spec'
import { DEFAULT_ALLOWLIST, parseQueryLog } from '../../main/services/sandbox-allowlist'

// ---------------------------------------------------------------------------
// firewall.test.ts (TRD §7.2 #3, #4, #5, #6, #14) — the egress allowlist
// firewall, against a real container. Every allowlist passed to
// init-firewall.sh here includes api.anthropic.com: the self-check itself
// resolves it (phase0-results.md's "Test-authoring caveat for 2.4"), so an
// allowlist missing it always exits 3, regardless of what the test means to
// prove.
//
// Every "blocked" assertion below checks the SPECIFIC evidence of a block
// (the exact curl/dig exit code and message a firewall rejection produces —
// empirically captured against a real container, not guessed), never just
// "the command didn't succeed" — a broad tolerance would make a broken curl
// or a dead resolver pass these tests for the wrong reason. Every blocked
// case also has an allowed-host positive control in the SAME container, so
// a tool that's silently broken (rather than genuinely firewalled) fails
// loudly instead of passing every "blocked" assertion vacuously.
// ---------------------------------------------------------------------------

function curlStatusArgv(url: string): string[] {
  return ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', url]
}

/** Strict — no tolerated exit code. A failure to reach an allowed host must fail the test, never be silently swallowed. */
async function curlAllowed(d: DockerRunner, container: TestContainer, identity: TestIdentity, url: string): Promise<string> {
  const result = await d.run(execAsArgv(container.name, identity, curlStatusArgv(url)))
  return result.stdout.trim()
}

/**
 * Same strict check as curlAllowed, but retried several times. Used only
 * right after a live update (§3.8.3): init-firewall.sh flushes the ipset
 * and restarts dnsmasq from scratch (4c/4d) before rebuilding the OUTPUT
 * chain, so EVERY domain — even ones already allowed before the update —
 * needs a fresh DNS round trip to repopulate the ipset; the 4g self-check
 * only proves that mechanism works for api.anthropic.com, not for
 * `url`'s own domain. That round trip (dnsmasq -> real upstream DNS over
 * the network -> ipset add -> reply) is real, observed to occasionally
 * take several seconds against the live internet (not sub-second — an
 * earlier, shorter retry budget here still flaked). A genuine firewall bug
 * fails every attempt identically, so this can't turn a real failure into
 * a false pass — it only absorbs that round trip's real latency.
 */
async function curlAllowedEventually(d: DockerRunner, container: TestContainer, identity: TestIdentity, url: string): Promise<string> {
  const attempts = 8
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await curlAllowed(d, container, identity, url)
    } catch (err) {
      if (attempt === attempts) throw err
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
  }
  // Unreachable — the loop above always returns (success) or throws (last attempt) — satisfies TypeScript's return-on-all-paths check.
  throw new Error('unreachable')
}

/**
 * Asserts BOTH the specific evidence a firewall rejection produces:
 * `%{http_code}` is "000" (curl never reached an HTTP response), and curl's
 * own exit code is exactly `expectedExitCode` — captured empirically
 * against a real firewalled container, not guessed:
 *   - a DNS-level refusal (dnsmasq REFUSED, e.g. example.org): curl exit 6
 *     ("couldn't resolve host").
 *   - an IP-level REJECT (iptables, e.g. the docker0 bridge): curl exit 7
 *     ("couldn't connect to host").
 * `allowExit` is scoped to exactly this one code, so any OTHER exit code
 * (a broken curl, a wrong URL, a timeout instead of a refusal) still fails
 * the test via docker.run()'s normal rejection, rather than being masked.
 */
async function curlBlocked(
  d: DockerRunner,
  container: TestContainer,
  identity: TestIdentity,
  url: string,
  expectedExitCode: 6 | 7,
): Promise<void> {
  const result = await d.run(execAsArgv(container.name, identity, curlStatusArgv(url)), { allowExit: [expectedExitCode] })
  expect(result.stdout.trim()).toBe('000')
  expect(result.exitCode).toBe(expectedExitCode)
}

const BASE_ALLOWLIST = [...DEFAULT_ALLOWLIST]

/**
 * The DNS status dnsmasq in the container gives for `name` (`dig` at 127.0.0.1, so no host network involved):
 * REFUSED for a name that isn't allowlisted, and anything else (NOERROR, or the upstream's own NXDOMAIN or
 * SERVFAIL) once it is forwarded. This is the deterministic half of the live-update check: it depends only on
 * the firewall's own config, not on whether the host's resolver is willing to answer for the name.
 */
async function dnsStatus(d: DockerRunner, container: TestContainer, identity: TestIdentity, name: string): Promise<string> {
  const result = await d.run(execAsArgv(container.name, identity, ['dig', '+time=3', '+tries=1', '+noall', '+comments', '@127.0.0.1', 'A', name]))
  const match = /status: ([A-Z]+)/.exec(result.stdout)
  if (!match) throw new Error('dig produced no status line')
  return match[1]
}

/** True when the HOST can resolve `name` to an IPv4 address; a host-side probe, so it says nothing about the container. */
async function hostResolves(name: string): Promise<boolean> {
  try {
    return (await dns.promises.resolve4(name)).length > 0
  } catch {
    return false
  }
}

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('firewall — TRD §7.2 #3, #4, #5, #6, #14', () => {
  let d: DockerRunner
  let identity: TestIdentity

  beforeAll(() => {
    d = docker()
    identity = makeIdentity()
  })

  // ── #3 / #4: a single long-lived allowlisted container for the stateless checks ──

  describe('§7.2 #3 — agent cannot touch firewall state; §7.2 #4 — allowlist enforcement', () => {
    let container: TestContainer

    beforeAll(async () => {
      await buildTestImage(d, identity)
      container = await createTestContainer(d, identity)
      await d.run(firewallInitArgv(container.name, 'allowlist'), { stdin: BASE_ALLOWLIST.join('\n'), timeoutMs: 30_000 })
    }, 5 * 60_000)

    afterAll(async () => {
      if (container) await removeTestContainer(d, container.name)
    }, 30_000)

    it('iptables-nft -F OUTPUT fails for the agent (EPERM)', async () => {
      await expect(d.run(execAsArgv(container.name, identity, ['/usr/sbin/iptables-nft', '-F', 'OUTPUT']))).rejects.toThrow()
    })

    it('ipset flush co-allow4 fails for the agent (EPERM)', async () => {
      await expect(d.run(execAsArgv(container.name, identity, ['/usr/sbin/ipset', 'flush', 'co-allow4']))).rejects.toThrow()
    })

    it('an allowlisted host connects', async () => {
      expect(await curlAllowed(d, container, identity, 'https://api.github.com')).toBe('200')
    })

    it('a non-allowlisted host is refused (dnsmasq REFUSED — curl exit 6, couldn\'t resolve host)', async () => {
      // Positive control: curl/DNS themselves work in this container.
      expect(await curlAllowed(d, container, identity, 'https://api.github.com')).toBe('200')
      await curlBlocked(d, container, identity, 'https://example.org', 6)
    })

    it('direct DNS to a non-codns upstream (bypassing the container resolver) is blocked', async () => {
      // Positive control: dig itself works, resolving through the
      // container's own (codns) resolver at 127.0.0.1.
      const control = await d.run(execAsArgv(container.name, identity, ['dig', '+time=2', '+tries=1', '+short', 'api.github.com']))
      expect(control.stdout.trim()).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)

      // The agent going straight to 8.8.8.8 (only codns may reach the
      // upstream on port 53) never gets a real answer — no resolved
      // address, and dig's own diagnostic names the specific failure
      // (captured empirically: "communications error ... host unreachable",
      // "no servers could be reached", exit 9). A missing/broken dig
      // (e.g. exit 127, not-found) is NOT in allowExit, so it still fails
      // this test rather than being mistaken for a firewall block.
      const result = await d.run(execAsArgv(container.name, identity, ['dig', '+time=2', '+tries=1', '@8.8.8.8', 'example.org']), {
        allowExit: [9],
      })
      expect(result.exitCode).toBe(9)
      expect(result.stdout).not.toMatch(/^example\.org\.\s+\d+\s+IN\s+A\s+\d/m)
      expect(result.stdout).toMatch(/communications error|no servers could be reached/i)
    })

    it('the docker0 bridge host is unreachable (iptables REJECT — curl exit 7), even though something is really listening there', async () => {
      const port = 41000 + Math.floor(Math.random() * 5000)
      const server = net.createServer((socket) => socket.end())
      await new Promise<void>((resolve, reject) => {
        server.on('error', reject)
        server.listen(port, '172.17.0.1', () => resolve())
      })
      try {
        // Positive control: the agent's networking (and this same curl
        // binary) works at all — just not to the host bridge.
        expect(await curlAllowed(d, container, identity, 'https://api.github.com')).toBe('200')
        await curlBlocked(d, container, identity, `http://172.17.0.1:${port}/`, 7)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })

  // ── #5: Blocked log via the codns poll + parser, and a live update ──

  describe('§7.2 #5 — Blocked log and live update', () => {
    let container: TestContainer

    beforeAll(async () => {
      await buildTestImage(d, identity)
      container = await createTestContainer(d, identity)
      await d.run(firewallInitArgv(container.name, 'allowlist'), { stdin: BASE_ALLOWLIST.join('\n'), timeoutMs: 30_000 })
    }, 5 * 60_000)

    afterAll(async () => {
      if (container) await removeTestContainer(d, container.name)
    }, 30_000)

    it('a blocked query is visible through the codns poll and the parser, and a live update unblocks it', async () => {
      // Positive control for this container.
      expect(await curlAllowed(d, container, identity, 'https://api.github.com')).toBe('200')

      // example.org is refused — this is what populates the query log line the parser reads.
      await curlBlocked(d, container, identity, 'https://example.org', 6)

      const polled = await d.run(blockedPollArgv(container.name, 0), { timeoutMs: 10_000 })
      const blocked = parseQueryLog(polled.stdout)
      expect(blocked).toContain('example.org')

      // Before the update dnsmasq itself refuses the name (positive control for the check after it).
      expect(await dnsStatus(d, container, identity, 'example.org')).toBe('REFUSED')

      // Live update: re-run init-firewall.sh with example.org added (§3.8.3 — no restart needed).
      await d.run(firewallInitArgv(container.name, 'allowlist'), {
        stdin: [...BASE_ALLOWLIST, 'example.org'].join('\n'),
        timeoutMs: 30_000,
      })

      // After it, the name is forwarded rather than refused. Deterministic: independent of what the upstream answers.
      expect(await dnsStatus(d, container, identity, 'example.org')).not.toBe('REFUSED')
    })

    it('after the live update, curl reaches example.org (only when the host itself resolves it)', async (ctx) => {
      if (!(await hostResolves('example.org'))) ctx.skip('this host cannot resolve example.org, so reachability from the container cannot be asserted')

      await d.run(firewallInitArgv(container.name, 'allowlist'), {
        stdin: [...BASE_ALLOWLIST, 'example.org'].join('\n'),
        timeoutMs: 30_000,
      })
      expect(await curlAllowedEventually(d, container, identity, 'https://example.org')).toBe('200')
    })
  })

  // ── #6: a hostile domain list is refused, and the previously-active rules survive ──

  describe('§7.2 #6 — hostile stdin exits 2 and leaves the rules unchanged', () => {
    let container: TestContainer

    beforeAll(async () => {
      await buildTestImage(d, identity)
      container = await createTestContainer(d, identity)
      await d.run(firewallInitArgv(container.name, 'allowlist'), { stdin: BASE_ALLOWLIST.join('\n'), timeoutMs: 30_000 })
    }, 5 * 60_000)

    afterAll(async () => {
      if (container) await removeTestContainer(d, container.name)
    }, 30_000)

    it('a hostile domain line exits 2 and the previously-established rules are still enforced', async () => {
      const hostile = [...BASE_ALLOWLIST, 'BAD_domain;rm -rf /'].join('\n')
      const result = await d.run(firewallInitArgv(container.name, 'allowlist'), { stdin: hostile, timeoutMs: 30_000, allowExit: [2] })
      expect(result.exitCode).toBe(2)

      // Unchanged: the host allowlisted before the hostile attempt is still allowed (positive control)...
      expect(await curlAllowed(d, container, identity, 'https://api.github.com')).toBe('200')
      // ...and the host that was never allowlisted is still refused, the same specific way as before.
      await curlBlocked(d, container, identity, 'https://example.org', 6)
    })
  })

  // ── #14: /run is a tmpfs, and an all-loopback upstream fails closed (exit 3) ──

  describe('§7.2 #14 — /run tmpfs and a loopback-only upstream fails closed', () => {
    let container: TestContainer

    beforeAll(async () => {
      await buildTestImage(d, identity)
    }, 5 * 60_000)

    afterAll(async () => {
      if (container) await removeTestContainer(d, container.name)
    }, 30_000)

    it('/run is mounted as a tmpfs', async () => {
      container = await createTestContainer(d, identity)
      // findmnt isn't in this image's package list — /proc/mounts is always
      // there and needs nothing extra: "<source> <target> <fstype> ...".
      const result = await d.run(execAsArgv(container.name, identity, ['/bin/sh', '-c', "awk '$2==\"/run\"{print $3}' /proc/mounts"]))
      expect(result.stdout.trim()).toBe('tmpfs')
    })

    it('an upstream nameserver of 127.0.0.11 (loopback-only) makes init-firewall.sh exit 3', async () => {
      const loopbackContainer = await createTestContainer(d, identity, { extraCreateFlags: ['--dns', '127.0.0.11'] })
      try {
        const result = await d.run(firewallInitArgv(loopbackContainer.name, 'allowlist'), {
          stdin: BASE_ALLOWLIST.join('\n'),
          timeoutMs: 30_000,
          allowExit: [3],
        })
        expect(result.exitCode).toBe(3)
      } finally {
        await removeTestContainer(d, loopbackContainer.name)
      }
    })
  })

  afterAll(async () => {
    await removeTestImage(d)
    removeIdentity(identity)
  }, 60_000)
})
