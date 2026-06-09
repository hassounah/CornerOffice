import crypto from 'crypto'
import type { HookEvent } from '../types'
import type { NotificationConfig } from '../types/config'

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
}

export interface NotificationCallbacks {
  showOsNotification: (title: string, body: string, workspaceSlug: string, eventTimestamp: string) => void
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
    const title = `${notification.workspace} -- ${notification.summary}`
    const body = notification.detail ?? ''
    this._callbacks.showOsNotification(title, body, notification.workspace, notification.timestamp)
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
