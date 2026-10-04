import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import {
  createSandboxNetwork,
  BLOCKED_CAP,
  BLOCKED_NOTIFY_INTERVAL_MS,
  BLOCKED_PUSH_DEBOUNCE_MS,
  LIVE_UPDATE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_BUFFER,
} from '../main/services/sandbox-network'
import { FIREWALL_INIT_TIMEOUT_MS } from '../main/services/sandbox-spec'
import type { SandboxNetworkDeps, SandboxNetworkService } from '../main/services/sandbox-network'
import { DockerError } from '../main/services/docker-runner'
import type { DockerResult, DockerRunner } from '../main/services/docker-runner'
import type { BlockedEntry } from '../main/types/sandbox'
import { FakeDockerRunner } from './helpers/fake-docker-runner'

// ---------------------------------------------------------------------------
// sandbox-network.test.ts — step 4.1 (TRD §3.8.2, §3.8.3; B-M4, B-L2, L4, Q8,
// UX-H1). The service runs on fake timers against a FakeDockerRunner; no
// manager or real Docker involved.
// ---------------------------------------------------------------------------

const NO_SUCH = { kind: 'failed' as const, subkind: 'no-such-container' as const, exitCode: 1, stderrTail: 'No such container' }
const DAEMON_DOWN = { kind: 'daemon-down' as const, exitCode: 1, stderrTail: 'Cannot connect' }

/** A refused lookup as dnsmasq logs it: the query line, then a REFUSED line that doesn't repeat the name. */
function refused(domain: string, pid = 100): string {
  return `Jan  1 00:00:00 dnsmasq[${pid}]: query[A] ${domain} from 127.0.0.1\nJan  1 00:00:00 dnsmasq[${pid}]: config error is REFUSED\n`
}

interface Rig {
  docker: FakeDockerRunner
  service: SandboxNetworkService
  running: Set<string>
  lists: Map<string, string[]>
  pushes: { slug: string; entries: BlockedEntry[] }[]
  notified: string[]
  statuses: { slug: string; status: string }[]
  stopped: string[]
  clock: { t: number }
}

function makeRig(overrides: Partial<SandboxNetworkDeps> = {}, docker: DockerRunner = new FakeDockerRunner()): Rig {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') }
  const running = new Set<string>(['a', 'b'])
  const lists = new Map<string, string[]>([
    ['a', ['github.com']],
    ['b', ['npmjs.org']],
  ])
  const pushes: Rig['pushes'] = []
  const notified: string[] = []
  const statuses: Rig['statuses'] = []
  const stopped: string[] = []
  const service = createSandboxNetwork({
    docker,
    now: () => clock.t,
    effectiveAllowlist: (slug) => lists.get(slug) ?? [],
    isLiveAllowlistSession: (slug) => running.has(slug),
    onBlocked: (slug, entries) => pushes.push({ slug, entries }),
    notifyBlocked: (slug) => notified.push(slug),
    onLiveUpdateStatus: (slug, status) => statuses.push({ slug, status }),
    onPollerStopped: (slug) => stopped.push(slug),
    ...overrides,
  })
  return { docker: docker as FakeDockerRunner, service, running, lists, pushes, notified, statuses, stopped, clock }
}

function pollCalls(docker: FakeDockerRunner, slug = 'a'): readonly string[][] {
  return docker.calls.filter((c) => c.args[0] === 'exec' && c.args.includes(`co-sandbox-${slug}`) && c.args.includes('/usr/bin/tail')).map((c) => [...c.args])
}

function firewallCalls(docker: FakeDockerRunner) {
  return docker.calls.filter((c) => c.args[0] === 'exec' && c.args.includes('/opt/co-sandbox/init-firewall.sh'))
}

beforeEach(() => {
  vi.useFakeTimers()
  mockLog.warn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('live update', () => {
  it('updates only affected, running allowlist sessions, with their own effective list on stdin', async () => {
    const rig = makeRig()
    rig.running.delete('b')

    rig.service.onSettingsChanged(['a', 'b'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    const calls = firewallCalls(rig.docker)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('co-sandbox-a')
    expect(calls[0].args).toContain('allowlist')
    expect(calls[0].opts?.stdin).toBe('github.com')
  })

  it('two workspaces updated within 500 ms each get their own update', async () => {
    const rig = makeRig()

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(200)
    rig.service.onSettingsChanged(['b'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    const targets = firewallCalls(rig.docker).map((c) => c.args.find((a) => a.startsWith('co-sandbox-')))
    expect(targets.sort()).toEqual(['co-sandbox-a', 'co-sandbox-b'])
  })

  it('a global plus workspace change together update both workspaces with the last list each', async () => {
    const rig = makeRig()

    rig.service.onSettingsChanged(['a', 'b'])
    rig.lists.set('a', ['github.com', 'pypi.org'])
    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    const calls = firewallCalls(rig.docker)
    expect(calls).toHaveLength(2)
    const byTarget = new Map(calls.map((c) => [c.args.find((a) => a.startsWith('co-sandbox-')), c.opts?.stdin]))
    expect(byTarget.get('co-sandbox-a')).toBe('github.com\npypi.org')
    expect(byTarget.get('co-sandbox-b')).toBe('npmjs.org')
  })

  it('reports ok after a successful update', async () => {
    const rig = makeRig()

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    expect(rig.statuses).toEqual([{ slug: 'a', status: 'ok' }])
    expect(rig.service.getLiveUpdateStatus('a')).toBe('ok')
    expect(rig.service.getLiveUpdateStatus('b')).toBeNull()
  })

  it('runs the live firewall update with the explicit firewall timeout', async () => {
    const rig = makeRig()

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    expect(firewallCalls(rig.docker)[0].opts?.timeoutMs).toBe(FIREWALL_INIT_TIMEOUT_MS)
  })

  it('reports a typed failure when the firewall script fails', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'init-firewall: bad domain' } })

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    // BE-M6: the cause (exit code and stderr tail) is in the log, not just the kind.
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringMatching(/live update failed for a: kind=failed exit=2 stderr="init-firewall: bad domain"/))

    expect(rig.statuses).toEqual([{ slug: 'a', status: 'failed' }])
    expect(rig.service.getLiveUpdateStatus('a')).toBe('failed')
  })

  it('a session that ended before the debounce fired is skipped', async () => {
    const rig = makeRig()

    rig.service.onSettingsChanged(['a'])
    rig.running.delete('a')
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    expect(firewallCalls(rig.docker)).toHaveLength(0)
  })

  it('sessionEnded cancels a pending update', async () => {
    const rig = makeRig()

    rig.service.onSettingsChanged(['a'])
    rig.service.sessionEnded('a')
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    expect(firewallCalls(rig.docker)).toHaveLength(0)
  })

  it('an unexpected error in the update is logged, not thrown', async () => {
    const docker: DockerRunner = {
      binary: () => ({ available: true, absPath: '/usr/bin/docker' }),
      run: async () => {
        throw new Error('boom')
      },
      stream: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }
    const rig = makeRig({}, docker)

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('live update crashed'))
  })

  it('a successful update restarts the poll offset (the script recreates the log empty)', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { result: { stdout: refused('evil.example'), stderr: '', exitCode: 0 } })
    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(pollCalls(rig.docker).at(-1)).not.toContain('+1')

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(pollCalls(rig.docker).at(-1)).toContain('+1')
  })
})

/** Holds every firewall run until released, so tests can overlap live updates. */
function gatedDocker(): { docker: DockerRunner; fake: FakeDockerRunner; release: () => void; active: { now: number; max: number }; started: (string | undefined)[] } {
  const fake = new FakeDockerRunner()
  const waiters: (() => void)[] = []
  const active = { now: 0, max: 0 }
  const started: (string | undefined)[] = []
  const docker: DockerRunner = {
    binary: () => fake.binary(),
    stream: (args, onLine, signal) => fake.stream(args, onLine, signal),
    run: async (args, opts) => {
      const isFirewall = args.includes('/opt/co-sandbox/init-firewall.sh')
      if (!isFirewall) return fake.run(args, opts)
      started.push(opts?.stdin)
      active.now += 1
      active.max = Math.max(active.max, active.now)
      await new Promise<void>((resolve) => waiters.push(resolve))
      active.now -= 1
      return fake.run(args, opts)
    },
  }
  return { docker, fake, release: () => waiters.shift()?.(), active, started }
}

describe('live update serialization', () => {
  it('overlapping changes run one at a time and coalesce into one re-run with the latest list', async () => {
    const gate = gatedDocker()
    const rig = makeRig({}, gate.docker)

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    expect(gate.started).toHaveLength(1)

    // Two more changes while the first run is still going.
    rig.lists.set('a', ['github.com', 'pypi.org'])
    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    expect(gate.started).toHaveLength(1)

    gate.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(gate.started).toEqual(['github.com', 'github.com\npypi.org'])

    gate.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(gate.started).toHaveLength(2)
    expect(gate.active.max).toBe(1)
    expect(rig.statuses).toEqual([
      { slug: 'a', status: 'ok' },
      { slug: 'a', status: 'ok' },
    ])
  })

  it('runs again after a finished update once a new change arrives', async () => {
    const gate = gatedDocker()
    const rig = makeRig({}, gate.docker)

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    gate.release()
    await vi.advanceTimersByTimeAsync(0)
    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    gate.release()
    await vi.advanceTimersByTimeAsync(0)

    expect(firewallCalls(gate.fake)).toHaveLength(2)
  })

  it('writes no status after the session ended during the run', async () => {
    const gate = gatedDocker()
    const rig = makeRig({}, gate.docker)

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    rig.running.delete('a')
    gate.release()
    await vi.advanceTimersByTimeAsync(0)

    expect(rig.statuses).toEqual([])
  })

  it('writes no failed status after the session ended during a failing run', async () => {
    const gate = gatedDocker()
    gate.fake.script(['exec'], { error: NO_SUCH })
    const rig = makeRig({}, gate.docker)

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    rig.running.delete('a')
    gate.release()
    await vi.advanceTimersByTimeAsync(0)

    expect(rig.statuses).toEqual([])
  })
})

describe('Blocked poller', () => {
  it('polls every 10 s as codns with the offset and a 1 MB buffer', async () => {
    const rig = makeRig()

    rig.service.sessionStarted('a')
    expect(pollCalls(rig.docker)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    const calls = rig.docker.calls.filter((c) => c.args.includes('/usr/bin/tail'))
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(expect.arrayContaining(['--user', 'codns', '-c', '+1']))
    expect(calls[0].args).not.toContain('root')
    expect(calls[0].opts?.maxBuffer).toBe(POLL_MAX_BUFFER)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(rig.docker.calls.filter((c) => c.args.includes('/usr/bin/tail'))).toHaveLength(2)
  })

  it('advances the offset by the bytes consumed', async () => {
    const rig = makeRig()
    const text = refused('blocked.example')
    rig.docker.script(['exec'], { result: { stdout: text, stderr: '', exitCode: 0 } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)

    expect(pollCalls(rig.docker).at(-1)).toContain(`+${Buffer.byteLength(text) + 1}`)
  })

  it('stores refused domains with count and times, and pushes after the 2 s debounce', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { result: { stdout: refused('blocked.example'), stderr: '', exitCode: 0 } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(rig.service.getBlocked('a')).toEqual([
      { domain: 'blocked.example', count: 1, firstSeen: expect.any(String), lastSeen: expect.any(String) },
    ])
    expect(rig.pushes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(BLOCKED_PUSH_DEBOUNCE_MS)
    expect(rig.pushes).toHaveLength(1)
    expect(rig.pushes[0].slug).toBe('a')
    expect(rig.pushes[0].entries[0].domain).toBe('blocked.example')
  })

  it('counts a domain seen again and orders the newest first', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { result: { stdout: refused('one.example') + refused('two.example', 101), stderr: '', exitCode: 0 } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(rig.service.getBlocked('a').map((e) => e.domain)).toEqual(['two.example', 'one.example'])
    rig.docker.script(['exec'], { result: { stdout: refused('one.example'), stderr: '', exitCode: 0 } })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    const entries = rig.service.getBlocked('a')
    expect(entries[0]).toMatchObject({ domain: 'one.example', count: 2 })
    expect(entries[1]).toMatchObject({ domain: 'two.example', count: 1 })
  })

  it('holds back a trailing query line until its REFUSED line has been written', async () => {
    const rig = makeRig()
    const done = refused('first.example')
    const partial = 'Jan  1 00:00:00 dnsmasq[101]: query[A] second.example from 127.0.0.1\n'
    rig.docker.script(['exec'], { result: { stdout: done + partial, stderr: '', exitCode: 0 } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(rig.service.getBlocked('a').map((e) => e.domain)).toEqual(['first.example'])

    // The next poll starts at the held-back query line and now sees its REFUSED line.
    rig.docker.script(['exec'], { result: { stdout: partial + 'Jan  1 00:00:00 dnsmasq[101]: config error is REFUSED\n', stderr: '', exitCode: 0 } })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(pollCalls(rig.docker).at(-1)).toContain(`+${Buffer.byteLength(done) + 1}`)
    expect(rig.service.getBlocked('a').map((e) => e.domain).sort()).toEqual(['first.example', 'second.example'])
  })

  it('ignores a partial last line without a newline', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { result: { stdout: 'Jan  1 00:00:00 dnsmasq[100]: query[A] half', stderr: '', exitCode: 0 } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)

    expect(rig.service.getBlocked('a')).toEqual([])
    expect(pollCalls(rig.docker).at(-1)).toContain('+1')
  })

  it('evicts the least recently seen domain at the 201st', async () => {
    const rig = makeRig()
    const lines = Array.from({ length: BLOCKED_CAP + 1 }, (_, i) => refused(`d${i}.example`, 1000 + i)).join('')
    rig.docker.script(['exec'], { result: { stdout: lines, stderr: '', exitCode: 0 } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    const domains = rig.service.getBlocked('a').map((e) => e.domain)
    expect(domains).toHaveLength(BLOCKED_CAP)
    expect(domains).not.toContain('d0.example')
    expect(domains).toContain(`d${BLOCKED_CAP}.example`)
  })

  it('stops cleanly on no-such-container and asks the manager to re-check, without retrying', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { error: NO_SUCH })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)

    expect(rig.stopped).toEqual(['a'])
    expect(rig.docker.calls.filter((c) => c.args.includes('/usr/bin/tail'))).toHaveLength(1)
  })

  it('stops on daemon-down too', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { error: DAEMON_DOWN })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

    expect(rig.stopped).toEqual(['a'])
  })

  it('keeps polling after another docker failure, one poll per interval', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'boom' } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

    expect(rig.stopped).toEqual([])
    expect(rig.docker.calls.filter((c) => c.args.includes('/usr/bin/tail'))).toHaveLength(3)
  })

  it('an unexpected error in a poll is logged and polling continues', async () => {
    let calls = 0
    const docker: DockerRunner = {
      binary: () => ({ available: true, absPath: '/usr/bin/docker' }),
      run: async (): Promise<DockerResult> => {
        calls += 1
        throw new Error('boom')
      },
      stream: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }
    const rig = makeRig({}, docker)

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)

    expect(calls).toBe(2)
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('poll crashed'))
  })

  it('does not poll once the session is no longer a live allowlist session', async () => {
    const rig = makeRig()

    rig.service.sessionStarted('a')
    rig.running.delete('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

    expect(rig.docker.calls.filter((c) => c.args.includes('/usr/bin/tail'))).toHaveLength(0)
  })

  it('sessionEnded forgets a failed live-update status (it belonged to the session that ended)', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'bad' } })
    rig.service.sessionStarted('a')
    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS)
    expect(rig.service.getLiveUpdateStatus('a')).toBe('failed')

    rig.service.sessionEnded('a')

    expect(rig.service.getLiveUpdateStatus('a')).toBeNull()
  })

  it('sessionEnded stops the poller and a pending push but keeps the entries', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { result: { stdout: refused('blocked.example'), stderr: '', exitCode: 0 } })
    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    rig.service.sessionEnded('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

    expect(rig.pushes).toHaveLength(0)
    expect(rig.docker.calls.filter((c) => c.args.includes('/usr/bin/tail'))).toHaveLength(1)
    expect(rig.service.getBlocked('a')).toHaveLength(1)
  })

  it('a new session clears the previous Blocked entries and restarts from offset 0', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { result: { stdout: refused('blocked.example'), stderr: '', exitCode: 0 } })
    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    rig.service.sessionEnded('a')

    rig.docker.script(['exec'], { result: { stdout: '', stderr: '', exitCode: 0 } })
    rig.service.sessionStarted('a')
    expect(rig.service.getBlocked('a')).toEqual([])
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(pollCalls(rig.docker).at(-1)).toContain('+1')
  })

  it('dispose cancels every timer', async () => {
    const rig = makeRig()
    rig.service.sessionStarted('a')
    rig.service.onSettingsChanged(['a'])

    rig.service.dispose()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

    expect(rig.docker.calls).toHaveLength(0)
  })

  it('returns no entries for a workspace that never had any', () => {
    expect(makeRig().service.getBlocked('nope')).toEqual([])
  })

  it('every poll argv runs as codns with a pinned PATH/HOME', async () => {
    const rig = makeRig()
    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    const args = pollCalls(rig.docker)[0]
    expect(args.slice(0, 3)).toEqual(['exec', '--user', 'codns'])
    expect(args).toContain('PATH=/usr/bin:/bin')
    expect(args).toContain('HOME=/')
  })
})

describe('Blocked notification', () => {
  async function blockNew(rig: Rig, domain: string, pid: number): Promise<void> {
    rig.docker.script(['exec'], { result: { stdout: refused(domain, pid), stderr: '', exitCode: 0 } })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  }

  it('fires on the first block, with no domain, and not again within 10 minutes', async () => {
    const rig = makeRig()
    rig.service.sessionStarted('a')

    await blockNew(rig, 'first.example', 1)
    expect(rig.notified).toEqual(['a'])

    await blockNew(rig, 'second.example', 2)
    expect(rig.notified).toEqual(['a'])
  })

  it('fires again after 10 minutes when a new domain appears', async () => {
    const rig = makeRig()
    rig.service.sessionStarted('a')
    await blockNew(rig, 'first.example', 1)

    rig.clock.t += BLOCKED_NOTIFY_INTERVAL_MS
    await blockNew(rig, 'second.example', 2)

    expect(rig.notified).toEqual(['a', 'a'])
  })

  it('does not fire after 10 minutes for a domain that was already known', async () => {
    const rig = makeRig()
    rig.service.sessionStarted('a')
    await blockNew(rig, 'first.example', 1)

    rig.clock.t += BLOCKED_NOTIFY_INTERVAL_MS
    await blockNew(rig, 'first.example', 2)

    expect(rig.notified).toEqual(['a'])
  })

  it('resets for a new session', async () => {
    const rig = makeRig()
    rig.service.sessionStarted('a')
    await blockNew(rig, 'first.example', 1)
    rig.service.sessionEnded('a')

    rig.service.sessionStarted('a')
    await blockNew(rig, 'first.example', 2)

    expect(rig.notified).toEqual(['a', 'a'])
  })
})

describe('poller robustness', () => {
  /** A runner whose poll fails the way a maxBuffer overflow does (no exit code, no stderr) while the unread remainder is over 1 MB. */
  function overflowingRunner(fileSize: number): { docker: DockerRunner; offsets: number[] } {
    const offsets: number[] = []
    const docker: DockerRunner = {
      binary: () => ({ available: true, absPath: '/usr/bin/docker' }),
      run: async (args): Promise<DockerResult> => {
        const plus = args.find((a) => /^\+\d+$/.test(a))
        if (!plus) return { stdout: '', stderr: '', exitCode: 0 }
        const offset = Number(plus.slice(1)) - 1
        offsets.push(offset)
        if (fileSize - offset > POLL_MAX_BUFFER) throw new DockerError('failed', { exitCode: null, stderrTail: '' })
        return { stdout: refused('after-flood.example'), stderr: '', exitCode: 0 }
      },
      stream: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }
    return { docker, offsets }
  }

  it('skips ahead after a buffer overflow so a log flood cannot stall the poller', async () => {
    const { docker, offsets } = overflowingRunner(POLL_MAX_BUFFER * 2 + 100)
    const rig = makeRig({}, docker)

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)

    expect(offsets.slice(0, 3)).toEqual([0, POLL_MAX_BUFFER, POLL_MAX_BUFFER * 2])
    expect(rig.service.getBlocked('a').map((e) => e.domain)).toEqual(['after-flood.example'])
    expect(mockLog.warn.mock.calls.filter(([m]) => String(m).includes('skipping ahead'))).toHaveLength(1)
  })

  it('does not skip ahead on an ordinary failure that has an exit code', async () => {
    const rig = makeRig()
    rig.docker.script(['exec'], { error: { kind: 'failed', exitCode: 1, stderrTail: 'boom' } })

    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)

    expect(pollCalls(rig.docker).every((args) => args.includes('+1'))).toBe(true)
  })

  it('discards a poll that was in flight when a live update recreated the log', async () => {
    let release: ((r: DockerResult) => void) | undefined
    const calls: string[][] = []
    const docker: DockerRunner = {
      binary: () => ({ available: true, absPath: '/usr/bin/docker' }),
      run: (args): Promise<DockerResult> => {
        calls.push([...args])
        if (args.includes('/usr/bin/tail') && calls.filter((c) => c.includes('/usr/bin/tail')).length === 1) {
          return new Promise((resolve) => {
            release = resolve
          })
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      },
      stream: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }
    const rig = makeRig({}, docker)
    rig.service.sessionStarted('a')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // the first poll is now pending

    rig.service.onSettingsChanged(['a'])
    await vi.advanceTimersByTimeAsync(LIVE_UPDATE_DEBOUNCE_MS) // the update completes: log recreated
    release?.({ stdout: refused('old-file.example'), stderr: '', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    expect(rig.service.getBlocked('a')).toEqual([])
    const tails = calls.filter((c) => c.includes('/usr/bin/tail'))
    expect(tails.at(-1)).toContain('+1')
  })
})
