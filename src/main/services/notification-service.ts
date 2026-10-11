import crypto from 'crypto'
import type { HookEvent } from '../types'
import type { NotificationConfig } from '../types/config'
import type { SandboxNotice } from '../types/sandbox'
import { getDescriptor } from '../agents/descriptors'

/** The only file names a quarantine notice repeats back. */
const QUARANTINE_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/
/** A path as the guard reports it: starts at `~/` and holds only plain path characters. */
const QUARANTINE_PATH_RE = /^~\/(?!.*\.\.)[A-Za-z0-9._/-]{1,400}$/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationTier = 'requiresAction' | 'idle' | 'progress' | 'activity'

export interface AppNotification {
  id: string
  workspace: string
  tier: NotificationTier
  summary: string
  detail: string | null
  timestamp: string
  autoDismissMs: number | null  // null = manual dismiss only
  /** Provenance (#0029, §3.17). Absent means host. A sandbox item's OS title starts with "Sandbox · <workspace>". */
  source?: 'host' | 'sandbox'
  /** Where a click on the OS notification should land (renderer-handled). */
  target?: string
  /** A command the user may copy and run themselves (the renderer shows a copy button; nothing runs it). Built from checked names only. */
  command?: string
}

export interface NotificationCallbacks {
  showOsNotification: (title: string, body: string, workspaceSlug: string, eventTimestamp: string, target?: string) => void
  getConfig: () => NotificationConfig
  getUnacknowledged: (workspaceSlug: string) => number
  setUnacknowledged: (workspaceSlug: string, count: number) => void
  onNotificationDispatched: (notification: AppNotification) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BANNERS = 3
const MAX_CONSECUTIVE_IDLE = 3
const ATTENTION_AUTO_DISMISS_MS = 60_000
const IDLE_CHECK_INTERVAL_MS = 60_000
const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

export class NotificationService {
  public suppressOsNotifications = false
  private _callbacks: NotificationCallbacks
  private _banners: AppNotification[] = []
  private _idleTimer: ReturnType<typeof setInterval> | null = null
  private _lastActivity = new Map<string, number>() // workspace -> epoch ms
  private _consecutiveIdle = new Map<string, number>() // workspace -> consecutive idle count
  private _idleSuppressed = new Set<string>() // workspaces whose session has no activity data (setIdleSuppressed)
  private _activePipelines = new Set<string>()      // workspace slugs with active pipeline

  constructor(callbacks: NotificationCallbacks) {
    this._callbacks = callbacks
  }

  // ---------------------------------------------------------------------------
  // Tier classification
  // ---------------------------------------------------------------------------

  /**
   * Classify a hook event into a notification tier.
   */
  classify(event: HookEvent): NotificationTier {
    const data = event.data

    // RequiresAction — direct permission/elicitation events
    if (event.event === 'PermissionRequest' || event.event === 'Elicitation') {
      return 'requiresAction'
    }

    // RequiresAction — permission gates, input needed
    if (event.event === 'Notification') {
      const t = ((event as Record<string, unknown>).notification_type ?? data.notification_type ?? data.type) as string | undefined
      if (t === 'permission_prompt' || t === 'permission_request' || t === 'user_input_needed') {
        return 'requiresAction'
      }
    }

    // Progress — pipeline milestones and learning events
    if (event.event === 'Stop') {
      if (
        data.featureShipped === true ||
        data.pipelineComplete === true ||
        data.gatePassed === true ||
        data.gateComplete === true ||
        data.reviewComplete === true
      ) {
        return 'progress'
      }
    }
    if (
      event.event === 'SubagentStop' &&
      (data.instinctLearned === true || data.instinctEvolved === true)
    ) {
      return 'progress'
    }

    // Everything else is activity tier
    return 'activity'
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a notification according to tier rules and config.
   */
  dispatch(notification: AppNotification): void {
    const config = this._callbacks.getConfig()
    const { tier } = notification

    // Track last activity for idle detection — reset consecutive idle counter on real activity
    this._lastActivity.set(notification.workspace, Date.now())
    if (tier !== 'idle') {
      this._consecutiveIdle.delete(notification.workspace)
    }

    if (tier === 'requiresAction') {
      // RequiresAction: always fires — bypasses quiet hours, always shows OS + banner
      if (!this.suppressOsNotifications) this._showOs(notification)
      this._addBanner(notification)
      const current = this._callbacks.getUnacknowledged(notification.workspace)
      this._callbacks.setUnacknowledged(notification.workspace, current + 1)
      this._callbacks.onNotificationDispatched(notification)
      return
    }

    // All other tiers respect quiet hours
    if (this._isQuietHours(config)) return

    if (tier === 'idle') {
      if (!config.tiers.idle.enabled) return
      if (!this.suppressOsNotifications && config.tiers.idle.osNotification && config.osNotificationsEnabled) {
        this._showOs(notification)
      }
      this._addBanner({ ...notification, autoDismissMs: ATTENTION_AUTO_DISMISS_MS })
      this._callbacks.onNotificationDispatched(notification)
      return
    }

    if (tier === 'progress') {
      if (!config.tiers.progress.enabled) return
      if (!this.suppressOsNotifications && config.tiers.progress.osNotification && config.osNotificationsEnabled) {
        this._showOs(notification)
      }
      // Progress is feed-only — no banner
      this._callbacks.onNotificationDispatched(notification)
      return
    }

    if (tier === 'activity') {
      if (!config.tiers.activity.enabled) return
      // Activity is feed-only — no banner, no OS notification
      this._callbacks.onNotificationDispatched(notification)
      return
    }
  }

  // ---------------------------------------------------------------------------
  // Banner management
  // ---------------------------------------------------------------------------

  getBanners(): AppNotification[] {
    return [...this._banners]
  }

  dismissBanner(id: string): void {
    const banner = this._banners.find((b) => b.id === id)
    if (banner?.tier === 'requiresAction') {
      const current = this._callbacks.getUnacknowledged(banner.workspace)
      if (current > 0) {
        this._callbacks.setUnacknowledged(banner.workspace, current - 1)
      }
    }
    this._banners = this._banners.filter((b) => b.id !== id)
  }

  /** Dismiss all banners for a workspace and clear its unacknowledged count */
  dismissAllForWorkspace(workspaceSlug: string): void {
    this._banners = this._banners.filter((b) => b.workspace !== workspaceSlug)
    this._callbacks.setUnacknowledged(workspaceSlug, 0)
  }

  // ---------------------------------------------------------------------------
  // Idle check (generates idle-tier notifications)
  // ---------------------------------------------------------------------------

  startIdleCheck(activePipelines: string[]): void {
    this._activePipelines = new Set(activePipelines)
    if (this._idleTimer) return
    this._idleTimer = setInterval(() => this._checkIdle(), IDLE_CHECK_INTERVAL_MS)
  }

  stopIdleCheck(): void {
    if (this._idleTimer) {
      clearInterval(this._idleTimer)
      this._idleTimer = null
    }
  }

  setActivePipelines(workspaceSlugs: string[]): void {
    this._activePipelines = new Set(workspaceSlugs)
  }

  /**
   * Turns the idle-timer notification off for `workspaceSlug` while its session has no activity data (an agent whose
   * plugin isn't installed): without events, a session waiting on an approval prompt would be reported as "idle".
   * Turning it off also forgets the idle counter, so a later session starts from zero.
   */
  setIdleSuppressed(workspaceSlug: string, on: boolean): void {
    if (on) {
      this._idleSuppressed.add(workspaceSlug)
      this._consecutiveIdle.delete(workspaceSlug)
    } else {
      this._idleSuppressed.delete(workspaceSlug)
    }
  }

  /**
   * Raises a notice from the sandbox subsystem with FIXED copy (§3.8.2, §3.12, UX-H1). The
   * inputs are enums and numbers only, so nothing an agent chooses (a domain, stderr) can
   * reach the text. Blocked needs action; the rest are progress-tier.
   */
  notifySandbox(notice: SandboxNotice): void {
    const base = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), autoDismissMs: null, source: 'sandbox' as const }
    switch (notice.kind) {
      case 'blocked':
        this.dispatch({
          ...base,
          workspace: notice.slug,
          tier: 'requiresAction',
          summary: 'Network request blocked',
          // The workspace is shown beside the text, and Realm truncates a body at 80 characters: keep this short and skin-neutral.
          detail: 'A network request was blocked. Review it in Sandbox settings.',
          target: 'sandbox-network',
        })
        return
      case 'unexpected-exit': {
        const why = notice.reason === 'docker-unavailable' ? 'Docker unavailable' : notice.exitCode === null ? 'the session exited' : `exit code ${notice.exitCode}`
        this.dispatch({
          ...base,
          workspace: notice.slug,
          tier: 'requiresAction',
          summary: 'Sandbox session ended unexpectedly',
          detail: `The session ended unexpectedly (${why}).`,
          target: 'sandbox-chooser',
        })
        return
      }
      case 'container-recreated':
        this.dispatch({
          ...base,
          workspace: notice.slug,
          tier: 'progress',
          summary: 'Sandbox container recreated',
          detail: 'The container for this workspace was recreated.',
        })
        return
      case 'agent-files-quarantined': {
        const agent = getDescriptor(notice.agentId)
        const home = `~/${agent.homeEntries[0] ?? ''}`
        // A name is shown only when it is plain text; anything else reads as "a new file" (the file name is agent-chosen).
        const file = notice.file !== null && QUARANTINE_NAME_RE.test(notice.file) ? notice.file : 'a new file'
        const destination = notice.destination !== null && QUARANTINE_PATH_RE.test(notice.destination) ? notice.destination : null
        const single = notice.count === 1 && destination !== null
        const where = destination ?? 'a quarantine folder'
        // Shown only for a plain name, so nothing agent-chosen reaches a shell command. Copying it is the user's decision; nothing runs it.
        const command = single && file !== 'a new file' ? `mv ${destination} ${home}/${file}` : undefined
        this.dispatch({
          ...base,
          workspace: notice.slug,
          // Moving files out of the host agent home is a security event: it can't be disabled or silenced.
          tier: 'requiresAction',
          summary: `Files moved out of ${home}`,
          detail: single
            ? `${agent.displayName} in the sandbox added ${file} to ${home}. ${agent.displayName} on your computer could load it, so Corner Office moved it to ${destination}. Nothing was deleted.${command ? ' If you trust it, review it and then move it back.' : ''}`
            : notice.count === 1
              ? `${agent.displayName} in the sandbox added ${file} to ${home}. ${agent.displayName} on your computer could load it, so Corner Office moved it aside. Nothing was deleted.`
              : `${agent.displayName} in the sandbox added ${notice.count} files to ${home}. ${agent.displayName} on your computer could load them, so Corner Office moved them to ${where}. Nothing was deleted.`,
          ...(command ? { command } : {}),
        })
        return
      }
      case 'agent-guard-incomplete': {
        const agent = getDescriptor(notice.agentId)
        const home = `~/${agent.homeEntries[0] ?? ''}`
        this.dispatch({
          ...base,
          workspace: notice.slug,
          tier: 'requiresAction',
          summary: `Couldn't finish checking ${home}`,
          detail: notice.lostBaseline
            ? `Corner Office lost track of which files in ${home} are yours, so ${agent.displayName} in the sandbox won't start. Files ${agent.displayName} could load were moved aside and nothing was deleted. Review ${home}, then delete this workspace's sandbox to reset.`
            : `${agent.displayName} in the sandbox left more in ${home} than Corner Office can check at once. New files that ${agent.displayName} could load were moved aside, nothing was deleted. ${agent.displayName} won't start in the sandbox again until the check can finish.`,
        })
        return
      }
      case 'image-ready':
        this.dispatch({
          ...base,
          workspace: notice.slug ?? '',
          tier: 'progress',
          summary: 'Sandbox image is ready',
          detail: null,
          // Fixed data chosen here: the requesting workspace's chooser, else Settings → Sandbox.
          target: notice.slug ? 'sandbox-chooser' : 'sandbox-image',
        })
        return
    }
  }

  recordActivity(workspaceSlug: string): void {
    this._lastActivity.set(workspaceSlug, Date.now())
    this._consecutiveIdle.delete(workspaceSlug)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _addBanner(notification: AppNotification): void {
    // Most recent on top; cap at MAX_BANNERS
    this._banners = [notification, ...this._banners].slice(0, MAX_BANNERS)
  }

  private _showOs(notification: AppNotification): void {
    const prefix = notification.source === 'sandbox' ? `Sandbox · ${notification.workspace}` : notification.workspace
    const title = notification.workspace ? `${prefix} -- ${notification.summary}` : notification.summary
    const body = notification.detail ?? ''
    if (notification.target) {
      this._callbacks.showOsNotification(title, body, notification.workspace, notification.timestamp, notification.target)
    } else {
      this._callbacks.showOsNotification(title, body, notification.workspace, notification.timestamp)
    }
  }

  private _isQuietHours(config: NotificationConfig): boolean {
    if (!config.quietHours.enabled) return false
    const now = new Date()
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    const [startH, startM] = config.quietHours.start.split(':').map(Number) as [number, number]
    const [endH, endM] = config.quietHours.end.split(':').map(Number) as [number, number]
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM
    if (startMinutes <= endMinutes) {
      // Same-day range (e.g., 09:00-17:00)
      return nowMinutes >= startMinutes && nowMinutes < endMinutes
    } else {
      // Overnight range (e.g., 22:00-08:00)
      return nowMinutes >= startMinutes || nowMinutes < endMinutes
    }
  }

  private _checkIdle(): void {
    const now = Date.now()
    for (const workspaceSlug of this._activePipelines) {
      if (this._idleSuppressed.has(workspaceSlug)) continue
      const consecutiveCount = this._consecutiveIdle.get(workspaceSlug) ?? 0
      if (consecutiveCount >= MAX_CONSECUTIVE_IDLE) continue

      const lastActivity = this._lastActivity.get(workspaceSlug) ?? 0
      const config = this._callbacks.getConfig()
      const thresholdMs = (config.idleThresholdMinutes ?? 5) * 60_000 || DEFAULT_IDLE_THRESHOLD_MS
      if (now - lastActivity > thresholdMs) {
        this._consecutiveIdle.set(workspaceSlug, consecutiveCount + 1)
        const notification: AppNotification = {
          id: crypto.randomUUID(),
          workspace: workspaceSlug,
          tier: 'idle',
          summary: 'Workspace idle',
          detail: `Active pipeline has been idle for ${config.idleThresholdMinutes ?? 5}+ minutes`,
          timestamp: new Date().toISOString(),
          autoDismissMs: ATTENTION_AUTO_DISMISS_MS,
        }
        this.dispatch(notification)
      }
    }
  }
}
