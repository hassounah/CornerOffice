import log from 'electron-log/main'
import { DockerError, describeDockerError } from './docker-runner'
import type { DockerRunner } from './docker-runner'
import { containerName, firewallInitArgv, blockedPollArgv, FIREWALL_INIT_TIMEOUT_MS } from './sandbox-spec'
import { parseQueryLog } from './sandbox-allowlist'
import type { BlockedEntry } from '../types/sandbox'

// ---------------------------------------------------------------------------
// sandbox-network.ts — live allowlist updates, the Blocked poller and the
// generic Blocked notification (TRD §3.8.2, §3.8.3; B-M4, B-L2, L4, L6, Q8,
// UX-H1). Owned by `sandbox-manager.ts`, which tells it when a session starts
// or ends and when settings change; everything it needs from the manager
// arrives through `SandboxNetworkDeps`.
// ---------------------------------------------------------------------------

export const LIVE_UPDATE_DEBOUNCE_MS = 500
export const POLL_INTERVAL_MS = 10_000
export const POLL_MAX_BUFFER = 1024 * 1024
export const BLOCKED_PUSH_DEBOUNCE_MS = 2_000
export const BLOCKED_NOTIFY_INTERVAL_MS = 10 * 60 * 1000
export const BLOCKED_CAP = 200

export type LiveUpdateStatus = 'ok' | 'failed'

export interface SandboxNetworkDeps {
  docker: DockerRunner
  now: () => number
  /** The effective allowlist for `slug`, read when the debounce fires so the last change wins. */
  effectiveAllowlist: (slug: string) => string[]
  /** True only for a running session in `allowlist` mode — the only kind a live update or poll applies to. */
  isLiveAllowlistSession: (slug: string) => boolean
  /** `sandbox:blocked`, debounced to 2 s. */
  onBlocked: (slug: string, entries: BlockedEntry[]) => void
  /** Generic OS notification: the caller supplies fixed copy, and it never names a domain (the agent chooses the name). */
  notifyBlocked: (slug: string) => void
  /** The live update's outcome changed (settings shows "Firewall update failed" on `failed`). */
  onLiveUpdateStatus: (slug: string, status: LiveUpdateStatus) => void
  /** The poller gave up on a vanished container or a dead daemon (B-L2): the manager should re-check Docker. */
  onPollerStopped: (slug: string) => void
}

export interface SandboxNetworkService {
  /** Starts the poller for a new `allowlist` session and clears that workspace's Blocked state. */
  sessionStarted(slug: string): void
  /** Stops the poller and any pending update or push for `slug`, and forgets its live-update status. The Blocked entries stay readable until the next start. */
  sessionEnded(slug: string): void
  /** One 500 ms debounce per slug (B-M4): each affected workspace gets its own update with its own latest list. */
  onSettingsChanged(affectedSlugs: readonly string[]): void
  getBlocked(slug: string): BlockedEntry[]
  getLiveUpdateStatus(slug: string): LiveUpdateStatus | null
  /** Cancels every timer (app quit). */
  dispose(): void
}

interface PollState {
  timer: NodeJS.Timeout | null
  offset: number
  /** Bumped whenever the log is known to have been recreated, so a poll already in flight can tell its result is for the old file. */
  epoch: number
  stopped: boolean
  loggedOverflow: boolean
}

interface NotifyState {
  lastNotifiedAt: number | null
}

export function createSandboxNetwork(deps: SandboxNetworkDeps): SandboxNetworkService {
  const { docker, now } = deps

  const updateTimers = new Map<string, NodeJS.Timeout>()
  /** One live update at a time per workspace; a change during a run asks for exactly one more. */
  const inFlight = new Map<string, Promise<void>>()
  const rerun = new Set<string>()
  const pollers = new Map<string, PollState>()
  /** `seq` orders "least recently seen" exactly, even for domains first seen in the same millisecond. */
  const blocked = new Map<string, Map<string, { count: number; firstSeen: string; lastSeen: string; seq: number }>>()
  let seq = 0
  const pushTimers = new Map<string, NodeJS.Timeout>()
  const notifyStates = new Map<string, NotifyState>()
  const liveStatus = new Map<string, LiveUpdateStatus>()

  const iso = (): string => new Date(now()).toISOString()

  // ── Live update (§3.8.3) ────────────────────────────────────────────────

  async function runLiveUpdate(slug: string): Promise<void> {
    if (!deps.isLiveAllowlistSession(slug)) return
    const list = deps.effectiveAllowlist(slug)
    try {
      await docker.run(firewallInitArgv(containerName(slug), 'allowlist'), { stdin: list.join('\n'), timeoutMs: FIREWALL_INIT_TIMEOUT_MS })
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      // A failure before the script touches any rule leaves the previous rules active. Past that point DNS
      // may be down with an empty set: stricter than before, never looser.
      log.warn(`[sandbox-network] live update failed for ${slug}: ${describeDockerError(err)}`)
      if (!deps.isLiveAllowlistSession(slug)) return
      liveStatus.set(slug, 'failed')
      deps.onLiveUpdateStatus(slug, 'failed')
      return
    }
    // The session may have ended while the script ran: don't write a status for it.
    if (!deps.isLiveAllowlistSession(slug)) return
    // The script recreates the query log empty, so the poller starts over from the top of the new file.
    const poller = pollers.get(slug)
    if (poller) {
      poller.offset = 0
      poller.epoch += 1
    }
    liveStatus.set(slug, 'ok')
    deps.onLiveUpdateStatus(slug, 'ok')
  }

  function requestLiveUpdate(slug: string): Promise<void> {
    const running = inFlight.get(slug)
    if (running) {
      rerun.add(slug)
      return running
    }
    const chain = (async () => {
      do {
        rerun.delete(slug)
        await runLiveUpdate(slug)
      } while (rerun.has(slug))
    })().finally(() => {
      inFlight.delete(slug)
      rerun.delete(slug)
    })
    inFlight.set(slug, chain)
    return chain
  }

  function onSettingsChanged(affectedSlugs: readonly string[]): void {
    for (const slug of new Set(affectedSlugs)) {
      const existing = updateTimers.get(slug)
      if (existing) clearTimeout(existing)
      updateTimers.set(
        slug,
        setTimeout(() => {
          updateTimers.delete(slug)
          requestLiveUpdate(slug).catch((err: unknown) => log.warn(`[sandbox-network] live update crashed for ${slug}: ${String(err)}`))
        }, LIVE_UPDATE_DEBOUNCE_MS),
      )
    }
  }

  // ── Blocked feed (§3.8.2) ───────────────────────────────────────────────

  function schedulePush(slug: string): void {
    if (pushTimers.has(slug)) return
    pushTimers.set(
      slug,
      setTimeout(() => {
        pushTimers.delete(slug)
        deps.onBlocked(slug, getBlocked(slug))
      }, BLOCKED_PUSH_DEBOUNCE_MS),
    )
  }

  /** Returns the domains that were not already in the store. */
  function record(slug: string, domains: readonly string[]): string[] {
    let store = blocked.get(slug)
    if (!store) {
      store = new Map()
      blocked.set(slug, store)
    }
    const at = iso()
    const fresh: string[] = []
    for (const domain of domains) {
      const existing = store.get(domain)
      if (existing) {
        existing.count += 1
        existing.lastSeen = at
        existing.seq = ++seq
      } else {
        fresh.push(domain)
        store.set(domain, { count: 1, firstSeen: at, lastSeen: at, seq: ++seq })
      }
    }
    while (store.size > BLOCKED_CAP) {
      let oldest: string | null = null
      for (const [domain, entry] of store) {
        if (oldest === null || entry.seq < store.get(oldest)!.seq) oldest = domain
      }
      if (oldest === null) break
      store.delete(oldest)
    }
    return fresh
  }

  function maybeNotify(slug: string, freshDomains: readonly string[]): void {
    if (freshDomains.length === 0) return
    const state = notifyStates.get(slug) ?? { lastNotifiedAt: null }
    notifyStates.set(slug, state)
    const t = now()
    if (state.lastNotifiedAt !== null && t - state.lastNotifiedAt < BLOCKED_NOTIFY_INTERVAL_MS) return
    state.lastNotifiedAt = t
    deps.notifyBlocked(slug)
  }

  /**
   * Only whole lines are consumed, and a trailing `query[` line is held back
   * for the next poll: its REFUSED line (which doesn't repeat the name) may
   * not have been written yet, and the parser pairs them within one text.
   * Returns the text to parse and how many bytes of the output it covers.
   */
  function consumable(output: string): { text: string; bytes: number } {
    const lastNewline = output.lastIndexOf('\n')
    if (lastNewline < 0) return { text: '', bytes: 0 }
    let text = output.slice(0, lastNewline + 1)
    const lines = text.split('\n')
    lines.pop() // the empty piece after the final newline
    const last = lines[lines.length - 1]
    if (last !== undefined && /\bquery\[/.test(last)) {
      lines.pop()
      text = lines.length > 0 ? lines.join('\n') + '\n' : ''
    }
    return { text, bytes: Buffer.byteLength(text, 'utf-8') }
  }

  async function pollOnce(slug: string, poller: PollState): Promise<void> {
    let stdout: string
    const epoch = poller.epoch
    try {
      const result = await docker.run(blockedPollArgv(containerName(slug), poller.offset), { maxBuffer: POLL_MAX_BUFFER })
      stdout = result.stdout
    } catch (err) {
      if (!(err instanceof DockerError)) throw err
      if (err.kind === 'daemon-down' || err.subkind === 'no-such-container') {
        // B-L2: no tight retry. The manager re-checks Docker, which drives the container and session states.
        log.warn(`[sandbox-network] poller for ${slug} stopped (${err.subkind ?? err.kind})`)
        poller.stopped = true
        deps.onPollerStopped(slug)
        return
      }
      if (err.kind === 'failed' && err.exitCode === null && epoch === poller.epoch) {
        // No exit code and no stderr: the unread remainder overflowed maxBuffer. The log is
        // agent-influenced and uncapped, so without skipping ahead a flood of lookups would
        // stall the poller for good and hide later blocks. The dropped chunk is at most 1 MB;
        // the parser only pairs complete query/REFUSED lines, so a mid-line start is harmless.
        poller.offset += POLL_MAX_BUFFER
        if (!poller.loggedOverflow) {
          poller.loggedOverflow = true
          log.warn(`[sandbox-network] query log backlog for ${slug} exceeded the poll buffer; skipping ahead`)
        }
        return
      }
      log.warn(`[sandbox-network] poll failed for ${slug} (${err.kind})`)
      return
    }

    // The log was recreated while this poll was in flight: its bytes belong to the old file.
    if (epoch !== poller.epoch) return

    const { text, bytes } = consumable(stdout)
    poller.offset += bytes
    if (!text) return
    // The query log is ground truth, so no allowlist re-filter (the names are
    // agent-chosen data: they are validated by the parser and shown as plain text).
    const domains = parseQueryLog(text)
    if (domains.length === 0) return
    const fresh = record(slug, domains)
    schedulePush(slug)
    maybeNotify(slug, fresh)
  }

  function scheduleNextPoll(slug: string, poller: PollState): void {
    if (poller.stopped) return
    poller.timer = setTimeout(() => {
      poller.timer = null
      if (poller.stopped || !deps.isLiveAllowlistSession(slug)) return
      pollOnce(slug, poller)
        .catch((err: unknown) => log.warn(`[sandbox-network] poll crashed for ${slug}: ${String(err)}`))
        .finally(() => scheduleNextPoll(slug, poller))
    }, POLL_INTERVAL_MS)
  }

  function stopPoller(slug: string): void {
    const poller = pollers.get(slug)
    if (!poller) return
    poller.stopped = true
    if (poller.timer) clearTimeout(poller.timer)
    pollers.delete(slug)
  }

  function sessionStarted(slug: string): void {
    stopPoller(slug)
    blocked.delete(slug)
    notifyStates.delete(slug)
    liveStatus.delete(slug)
    const poller: PollState = { timer: null, offset: 0, epoch: 0, stopped: false, loggedOverflow: false }
    pollers.set(slug, poller)
    scheduleNextPoll(slug, poller)
  }

  function sessionEnded(slug: string): void {
    stopPoller(slug)
    const update = updateTimers.get(slug)
    if (update) clearTimeout(update)
    updateTimers.delete(slug)
    const push = pushTimers.get(slug)
    if (push) clearTimeout(push)
    pushTimers.delete(slug)
    // A failed live update is about THAT session's firewall; once it has ended, Settings must stop showing "Firewall update failed".
    liveStatus.delete(slug)
  }

  function getBlocked(slug: string): BlockedEntry[] {
    const store = blocked.get(slug)
    if (!store) return []
    return [...store.entries()]
      .sort(([, a], [, b]) => b.seq - a.seq)
      .map(([domain, e]) => ({ domain, count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen }))
  }

  function dispose(): void {
    for (const slug of [...pollers.keys()]) stopPoller(slug)
    for (const t of updateTimers.values()) clearTimeout(t)
    for (const t of pushTimers.values()) clearTimeout(t)
    updateTimers.clear()
    pushTimers.clear()
  }

  return {
    sessionStarted,
    sessionEnded,
    onSettingsChanged,
    getBlocked,
    getLiveUpdateStatus: (slug) => liveStatus.get(slug) ?? null,
    dispose,
  }
}
