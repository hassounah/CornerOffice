import { describe, it, expect, vi, afterEach } from 'vitest'
import { NotificationService } from '../main/services/notification-service'
import type { AppNotification, NotificationCallbacks } from '../main/services/notification-service'
import type { HookEvent } from '../main/types'
import type { NotificationConfig } from '../main/types/config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
  return {
    osNotificationsEnabled: true,
    showMissedOnStartup: true,
    tiers: {
      requiresAction: { enabled: true, sound: false },
      idle: { enabled: true, osNotification: true },
      progress: { enabled: true, osNotification: false },
      activity: { enabled: true },
    },
    idleThresholdMinutes: 5,
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '08:00',
    },
    ...overrides,
  }
}

function makeCallbacks(configOverrides: Partial<NotificationConfig> = {}): NotificationCallbacks & {
  showOsNotification: ReturnType<typeof vi.fn<(title: string, body: string, workspaceSlug: string, eventTimestamp: string) => void>>
  unacknowledged: Record<string, number>
} {
  const unacknowledged: Record<string, number> = {}
  return {
    showOsNotification: vi.fn<(title: string, body: string, workspaceSlug: string, eventTimestamp: string) => void>(),
    getConfig: () => makeConfig(configOverrides),
    getUnacknowledged: (slug) => unacknowledged[slug] ?? 0,
    setUnacknowledged: (slug, count) => { unacknowledged[slug] = count },
    onNotificationDispatched: vi.fn<(notification: AppNotification) => void>(),
    unacknowledged,
  }
}

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'test-id',
    workspace: 'my-project',
    tier: 'requiresAction',
    summary: 'Permission required',
    detail: 'Tool use pending',
    timestamp: '2026-03-01T10:00:00Z',
    autoDismissMs: null,
    ...overrides,
  }
}

function makeHookEvent(event: string, data: Record<string, unknown> = {}): HookEvent {
  return {
    timestamp: '2026-03-01T10:00:00Z',
    event: event as HookEvent['event'],
    workspace: 'ws',
    sessionId: 's',
    data,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationService', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // classify()
  // -------------------------------------------------------------------------

  describe('classify', () => {
    it('classifies permission_request as requiresAction', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('Notification', { type: 'permission_request' }))).toBe('requiresAction')
    })

    it('classifies user_input_needed as requiresAction', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('Notification', { type: 'user_input_needed' }))).toBe('requiresAction')
    })

    it('classifies Notification with top-level notification_type permission_prompt as requiresAction', () => {
      const svc = new NotificationService(makeCallbacks())
      const event = { ...makeHookEvent('Notification'), notification_type: 'permission_prompt' }
      expect(svc.classify(event as never)).toBe('requiresAction')
    })

    it('classifies featureShipped Stop as progress', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('Stop', { featureShipped: true }))).toBe('progress')
    })

    it('classifies gatePassed Stop as progress', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('Stop', { gatePassed: true }))).toBe('progress')
    })

    it('classifies reviewComplete Stop as progress', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('Stop', { reviewComplete: true }))).toBe('progress')
    })

    it('classifies SubagentStop with instinctLearned as progress', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('SubagentStop', { instinctLearned: true }))).toBe('progress')
    })

    it('classifies PermissionRequest as requiresAction', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('PermissionRequest'))).toBe('requiresAction')
    })

    it('classifies Elicitation as requiresAction', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('Elicitation'))).toBe('requiresAction')
    })

    it('classifies SessionStart as activity', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('SessionStart'))).toBe('activity')
    })

    it('classifies plain Stop as activity', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('Stop'))).toBe('activity')
    })

    it('classifies PreCompact as activity', () => {
      const svc = new NotificationService(makeCallbacks())
      expect(svc.classify(makeHookEvent('PreCompact'))).toBe('activity')
    })
  })

  // -------------------------------------------------------------------------
  // dispatch() — requiresAction
  // -------------------------------------------------------------------------

  describe('dispatch — requiresAction', () => {
    it('shows OS notification', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(callbacks.showOsNotification).toHaveBeenCalledOnce()
    })

    it('formats title as workspace -- summary', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ workspace: 'ws-a', summary: 'Needs input', tier: 'requiresAction' }))
      expect(callbacks.showOsNotification).toHaveBeenCalledWith('ws-a -- Needs input', expect.any(String), 'ws-a', expect.any(String))
    })

    it('adds banner', () => {
      const svc = new NotificationService(makeCallbacks())
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(svc.getBanners()).toHaveLength(1)
    })

    it('increments unacknowledged count', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      expect(callbacks.unacknowledged['ws-a']).toBe(2)
    })

    it('bypasses quiet hours', () => {
      const callbacks = makeCallbacks({
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(callbacks.showOsNotification).toHaveBeenCalled()
    })

    it('calls onNotificationDispatched', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      const notif = makeNotification({ tier: 'requiresAction' })
      svc.dispatch(notif)
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledWith(notif)
    })

    it('calls onNotificationDispatched even during quiet hours', () => {
      const callbacks = makeCallbacks({
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // dispatch() — attention
  // -------------------------------------------------------------------------

  describe('dispatch — idle', () => {
    it('shows OS notification when osNotification enabled', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(callbacks.showOsNotification).toHaveBeenCalled()
    })

    it('does not show OS notification when idle.osNotification is false', () => {
      const callbacks = makeCallbacks({
        tiers: {
          requiresAction: { enabled: true, sound: false },
          idle: { enabled: true, osNotification: false },
          progress: { enabled: true, osNotification: false },
          activity: { enabled: true },
        },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('adds banner with 60s auto-dismiss', () => {
      const svc = new NotificationService(makeCallbacks())
      svc.dispatch(makeNotification({ tier: 'idle', autoDismissMs: null }))
      const banners = svc.getBanners()
      expect(banners[0].autoDismissMs).toBe(60_000)
    })

    it('skips when quiet hours active', () => {
      const callbacks = makeCallbacks({
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('skips when idle tier disabled', () => {
      const callbacks = makeCallbacks({
        tiers: {
          requiresAction: { enabled: true, sound: false },
          idle: { enabled: false, osNotification: true },
          progress: { enabled: true, osNotification: false },
          activity: { enabled: true },
        },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('calls onNotificationDispatched when enabled', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
    })

    it('does NOT call onNotificationDispatched during quiet hours', () => {
      const callbacks = makeCallbacks({
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(callbacks.onNotificationDispatched).not.toHaveBeenCalled()
    })

    it('does NOT call onNotificationDispatched when tier disabled', () => {
      const callbacks = makeCallbacks({
        tiers: {
          requiresAction: { enabled: true, sound: false },
          idle: { enabled: false, osNotification: true },
          progress: { enabled: true, osNotification: false },
          activity: { enabled: true },
        },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(callbacks.onNotificationDispatched).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // dispatch() — progress
  // -------------------------------------------------------------------------

  describe('dispatch — progress', () => {
    it('shows OS notification when progress.osNotification enabled', () => {
      const callbacks = makeCallbacks({
        tiers: {
          requiresAction: { enabled: true, sound: false },
          idle: { enabled: true, osNotification: true },
          progress: { enabled: true, osNotification: true },
          activity: { enabled: true },
        },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'progress' }))
      expect(callbacks.showOsNotification).toHaveBeenCalled()
    })

    it('does NOT add banner (feed only)', () => {
      const svc = new NotificationService(makeCallbacks())
      svc.dispatch(makeNotification({ tier: 'progress' }))
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('skips when progress tier disabled', () => {
      const callbacks = makeCallbacks({
        tiers: {
          requiresAction: { enabled: true, sound: false },
          idle: { enabled: true, osNotification: true },
          progress: { enabled: false, osNotification: false },
          activity: { enabled: true },
        },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'progress' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('calls onNotificationDispatched when enabled', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'progress' }))
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
    })

    it('does NOT call onNotificationDispatched when tier disabled', () => {
      const callbacks = makeCallbacks({
        tiers: {
          requiresAction: { enabled: true, sound: false },
          idle: { enabled: true, osNotification: true },
          progress: { enabled: false, osNotification: false },
          activity: { enabled: true },
        },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'progress' }))
      expect(callbacks.onNotificationDispatched).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // dispatch() — activity
  // -------------------------------------------------------------------------

  describe('dispatch — activity', () => {
    it('does NOT show OS notification', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'activity' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('does NOT add banner', () => {
      const svc = new NotificationService(makeCallbacks())
      svc.dispatch(makeNotification({ tier: 'activity' }))
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('calls onNotificationDispatched when enabled', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'activity' }))
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
    })

    it('does NOT call onNotificationDispatched when tier disabled', () => {
      const callbacks = makeCallbacks({
        tiers: {
          requiresAction: { enabled: true, sound: false },
          idle: { enabled: true, osNotification: true },
          progress: { enabled: true, osNotification: false },
          activity: { enabled: false },
        },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'activity' }))
      expect(callbacks.onNotificationDispatched).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // suppressOsNotifications flag
  // -------------------------------------------------------------------------

  describe('suppressOsNotifications', () => {
    it('suppressOsNotifications=false (default) fires OS notification for requiresAction', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(callbacks.showOsNotification).toHaveBeenCalledOnce()
    })

    it('suppressOsNotifications=true suppresses OS notification for requiresAction', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('suppressOsNotifications=true still adds banner for requiresAction', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(svc.getBanners()).toHaveLength(1)
    })

    it('suppressOsNotifications=true still calls onNotificationDispatched for requiresAction', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
    })

    it('suppressOsNotifications=true suppresses OS notification for idle tier', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('suppressOsNotifications=true suppresses OS notification for progress tier', () => {
      const callbacks = makeCallbacks({ tiers: {
        requiresAction: { enabled: true, sound: false },
        idle: { enabled: true, osNotification: true },
        progress: { enabled: true, osNotification: true },
        activity: { enabled: true },
      }})
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'progress' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('_showOs passes eventTimestamp as 4th arg to showOsNotification', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      const ts = '2026-03-01T10:00:00Z'
      svc.dispatch(makeNotification({ tier: 'requiresAction', timestamp: ts }))
      expect(callbacks.showOsNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        ts,
      )
    })
  })

  // -------------------------------------------------------------------------
  // Banner management
  // -------------------------------------------------------------------------

  describe('banner management', () => {
    it('caps banner stack at 3', () => {
      const svc = new NotificationService(makeCallbacks())
      for (let i = 0; i < 5; i++) {
        svc.dispatch(makeNotification({ id: `id-${i}`, tier: 'requiresAction' }))
      }
      expect(svc.getBanners()).toHaveLength(3)
    })

    it('most recent banner is first', () => {
      const svc = new NotificationService(makeCallbacks())
      svc.dispatch(makeNotification({ id: 'first', tier: 'requiresAction' }))
      svc.dispatch(makeNotification({ id: 'second', tier: 'requiresAction' }))
      expect(svc.getBanners()[0].id).toBe('second')
    })

    it('dismissBanner removes the banner', () => {
      const svc = new NotificationService(makeCallbacks())
      svc.dispatch(makeNotification({ id: 'del-me', tier: 'idle' }))
      svc.dismissBanner('del-me')
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('dismissBanner decrements unacknowledged for requiresAction', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ id: 'del-me', workspace: 'ws-a', tier: 'requiresAction' }))
      expect(callbacks.unacknowledged['ws-a']).toBe(1)
      svc.dismissBanner('del-me')
      expect(callbacks.unacknowledged['ws-a']).toBe(0)
    })

    it('dismissAllForWorkspace clears banners and resets unacknowledged', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      svc.dismissAllForWorkspace('ws-a')
      expect(svc.getBanners()).toHaveLength(0)
      expect(callbacks.unacknowledged['ws-a']).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Quiet hours
  // -------------------------------------------------------------------------

  describe('quiet hours', () => {
    it('blocks idle notification during quiet hours', () => {
      const callbacks = makeCallbacks({
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('does not block when quiet hours disabled', () => {
      const callbacks = makeCallbacks({
        quietHours: { enabled: false, start: '00:00', end: '23:59' },
      })
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(svc.getBanners()).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Attention clearing (via setUnacknowledged)
  // -------------------------------------------------------------------------

  describe('attention clearing', () => {
    it('unacknowledged count starts at 0', () => {
      const callbacks = makeCallbacks()
      expect(callbacks.getUnacknowledged('ws-a')).toBe(0)
    })

    it('dispatch requiresAction increments unacknowledged count', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      expect(callbacks.getUnacknowledged('ws-a')).toBe(1)
    })

    it('setUnacknowledged to 0 clears attention state (simulating follow-up activity)', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      // Simulate two requiresAction events building up the count
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      expect(callbacks.getUnacknowledged('ws-a')).toBe(2)
      // Simulate follow-up activity clearing — this is what ingestEvents does
      callbacks.setUnacknowledged('ws-a', 0)
      expect(callbacks.getUnacknowledged('ws-a')).toBe(0)
    })

    it('clearing one workspace does not affect another', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      svc.dispatch(makeNotification({ workspace: 'ws-b', tier: 'requiresAction' }))
      // Clear ws-a (simulating follow-up activity)
      callbacks.setUnacknowledged('ws-a', 0)
      expect(callbacks.getUnacknowledged('ws-a')).toBe(0)
      expect(callbacks.getUnacknowledged('ws-b')).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // suppressOsNotifications flag
  // -------------------------------------------------------------------------

  describe('suppressOsNotifications', () => {
    it('suppresses OS notification for requiresAction when flag is true', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('still adds banner for requiresAction when suppress=true', () => {
      const svc = new NotificationService(makeCallbacks())
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'requiresAction' }))
      expect(svc.getBanners()).toHaveLength(1)
    })

    it('still increments unacknowledged count for requiresAction when suppress=true', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      expect(callbacks.unacknowledged['ws-a']).toBe(1)
    })

    it('still calls onNotificationDispatched for requiresAction when suppress=true', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      const notif = makeNotification({ tier: 'requiresAction' })
      svc.dispatch(notif)
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
    })

    it('suppresses OS notification for idle tier when flag is true', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(callbacks.showOsNotification).not.toHaveBeenCalled()
    })

    it('still adds banner and calls onNotificationDispatched for idle when suppress=true', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.suppressOsNotifications = true
      svc.dispatch(makeNotification({ tier: 'idle' }))
      expect(svc.getBanners()).toHaveLength(1)
      expect(callbacks.onNotificationDispatched).toHaveBeenCalledOnce()
    })

    it('passes notification.timestamp to showOsNotification', () => {
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      const ts = '2026-03-23T10:00:00Z'
      svc.dispatch(makeNotification({ tier: 'requiresAction', timestamp: ts }))
      expect(callbacks.showOsNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        ts,
      )
    })
  })

  // -------------------------------------------------------------------------
  // Idle check
  // -------------------------------------------------------------------------

  describe('idle check', () => {
    it('fires idle notification after 5+ min inactivity', () => {
      vi.useFakeTimers()
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.startIdleCheck(['ws-a'])
      // Advance 6 minutes to trigger idle
      vi.advanceTimersByTime(6 * 60_000)
      expect(svc.getBanners().some((b) => b.tier === 'idle')).toBe(true)
    })

    it('does not fire if recently active', () => {
      vi.useFakeTimers()
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.startIdleCheck(['ws-a'])
      svc.recordActivity('ws-a')
      vi.advanceTimersByTime(4 * 60_000)
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('stopIdleCheck prevents further idle notifications', () => {
      vi.useFakeTimers()
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.startIdleCheck(['ws-a'])
      svc.stopIdleCheck()
      vi.advanceTimersByTime(10 * 60_000)
      expect(svc.getBanners()).toHaveLength(0)
    })

    it('is idempotent — second startIdleCheck does not create extra intervals', () => {
      vi.useFakeTimers()
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.startIdleCheck(['ws-a'])
      svc.startIdleCheck(['ws-a'])
      vi.advanceTimersByTime(6 * 60_000)
      // Should only generate 1 idle notification per interval, not 2
      const attentionBanners = svc.getBanners().filter((b) => b.tier === 'idle')
      expect(attentionBanners.length).toBeLessThanOrEqual(3) // capped by MAX_BANNERS
    })

    it('caps consecutive idle notifications at 3 per workspace', () => {
      vi.useFakeTimers()
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.startIdleCheck(['ws-a'])
      // Advance 30 minutes — should trigger idle check 30 times but cap at 3
      vi.advanceTimersByTime(30 * 60_000)
      const dispatched = (callbacks.onNotificationDispatched as ReturnType<typeof vi.fn>).mock.calls
      const idleDispatches = dispatched.filter((args: unknown[]) => (args[0] as AppNotification).tier === 'idle')
      expect(idleDispatches).toHaveLength(3)
    })

    it('resets consecutive idle counter when activity resumes', () => {
      vi.useFakeTimers()
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.startIdleCheck(['ws-a'])
      // Trigger 3 idle notifications (exhaust the cap)
      vi.advanceTimersByTime(30 * 60_000)
      const dispatchedBefore = (callbacks.onNotificationDispatched as ReturnType<typeof vi.fn>).mock.calls
        .filter((args: unknown[]) => (args[0] as AppNotification).tier === 'idle').length
      expect(dispatchedBefore).toBe(3)

      // Record activity — resets the counter and the idle timer
      svc.recordActivity('ws-a')
      ;(callbacks.onNotificationDispatched as ReturnType<typeof vi.fn>).mockClear()

      // Advance another 30 minutes — should get 3 more idle notifications
      vi.advanceTimersByTime(30 * 60_000)
      const dispatchedAfter = (callbacks.onNotificationDispatched as ReturnType<typeof vi.fn>).mock.calls
        .filter((args: unknown[]) => (args[0] as AppNotification).tier === 'idle').length
      expect(dispatchedAfter).toBe(3)
    })

    it('resets consecutive idle counter on non-idle dispatch', () => {
      vi.useFakeTimers()
      const callbacks = makeCallbacks()
      const svc = new NotificationService(callbacks)
      svc.startIdleCheck(['ws-a'])
      // Exhaust idle cap
      vi.advanceTimersByTime(30 * 60_000)

      // Dispatch a non-idle notification (e.g., requiresAction) — resets counter
      svc.dispatch(makeNotification({ workspace: 'ws-a', tier: 'requiresAction' }))
      ;(callbacks.onNotificationDispatched as ReturnType<typeof vi.fn>).mockClear()

      // Advance again — should get 3 more idle notifications
      vi.advanceTimersByTime(30 * 60_000)
      const idleAfter = (callbacks.onNotificationDispatched as ReturnType<typeof vi.fn>).mock.calls
        .filter((args: unknown[]) => (args[0] as AppNotification).tier === 'idle').length
      expect(idleAfter).toBe(3)
    })
  })
})

// ---------------------------------------------------------------------------
// Sandbox provenance and notices (#0029, §3.8.2, §3.12, §3.17, UX-H1)
// ---------------------------------------------------------------------------

describe('NotificationService — sandbox provenance', () => {
  it('prefixes an OS title with "Sandbox · <ws>" for a sandbox item, and leaves a host item alone', () => {
    const callbacks = makeCallbacks()
    const svc = new NotificationService(callbacks)

    svc.dispatch(makeNotification({ workspace: 'ws-a', summary: 'Needs input', source: 'sandbox' }))
    svc.dispatch(makeNotification({ workspace: 'ws-a', summary: 'Needs input', source: 'host' }))

    expect(callbacks.showOsNotification).toHaveBeenNthCalledWith(1, 'Sandbox · ws-a -- Needs input', expect.any(String), 'ws-a', expect.any(String))
    expect(callbacks.showOsNotification).toHaveBeenNthCalledWith(2, 'ws-a -- Needs input', expect.any(String), 'ws-a', expect.any(String))
  })

  it('passes the click target as a fifth argument only when there is one', () => {
    const callbacks = makeCallbacks()
    const svc = new NotificationService(callbacks)

    svc.dispatch(makeNotification({ target: 'sandbox-network' }))
    svc.dispatch(makeNotification())

    const [withTarget, without] = (callbacks.showOsNotification as ReturnType<typeof vi.fn>).mock.calls
    expect(withTarget[4]).toBe('sandbox-network')
    expect(without).toHaveLength(4)
  })

  it('delivers source and target to the dispatched notification untouched', () => {
    const callbacks = makeCallbacks()
    new NotificationService(callbacks).dispatch(makeNotification({ source: 'sandbox', target: 'sandbox-chooser' }))
    expect(callbacks.onNotificationDispatched).toHaveBeenCalledWith(expect.objectContaining({ source: 'sandbox', target: 'sandbox-chooser' }))
  })
})

describe('NotificationService.notifySandbox', () => {
  function dispatched(callbacks: ReturnType<typeof makeCallbacks>): AppNotification[] {
    return (callbacks.onNotificationDispatched as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) => args[0] as AppNotification)
  }

  it('blocked: requiresAction, sandbox source, target sandbox-network, fixed copy that never names a domain', () => {
    const callbacks = makeCallbacks()
    new NotificationService(callbacks).notifySandbox({ kind: 'blocked', slug: 'ws-a' })

    const [n] = dispatched(callbacks)
    expect(n).toMatchObject({
      workspace: 'ws-a',
      tier: 'requiresAction',
      source: 'sandbox',
      target: 'sandbox-network',
      detail: 'A network request was blocked. Review it in Sandbox settings.',
    })
    expect(callbacks.showOsNotification).toHaveBeenCalledWith('Sandbox · ws-a -- Network request blocked', n.detail, 'ws-a', n.timestamp, 'sandbox-network')
    expect(callbacks.unacknowledged['ws-a']).toBe(1)
  })

  it.each([
    [{ reason: 'docker-unavailable' as const, exitCode: 1 }, 'Docker unavailable'],
    [{ reason: 'exited' as const, exitCode: 137 }, 'exit code 137'],
    [{ reason: 'exited' as const, exitCode: null }, 'the session exited'],
  ])('unexpected-exit %j reads "(%s)"', (extra, why) => {
    const callbacks = makeCallbacks()
    new NotificationService(callbacks).notifySandbox({ kind: 'unexpected-exit', slug: 'ws-a', ...extra })

    const [n] = dispatched(callbacks)
    expect(n).toMatchObject({ tier: 'requiresAction', source: 'sandbox', summary: 'Sandbox session ended unexpectedly' })
    expect(n.detail).toBe(`The session ended unexpectedly (${why}).`)
    expect(n).toMatchObject({ workspace: 'ws-a', target: 'sandbox-chooser' })
    expect(n.detail?.length).toBeLessThanOrEqual(80)
  })

  it('container-recreated is a progress-tier notice', () => {
    const callbacks = makeCallbacks()
    new NotificationService(callbacks).notifySandbox({ kind: 'container-recreated', slug: 'ws-a' })
    expect(dispatched(callbacks)[0]).toMatchObject({ tier: 'progress', source: 'sandbox', summary: 'Sandbox container recreated' })
  })

  it('image-ready for a requesting workspace: names it and targets its chooser', () => {
    const callbacks = makeCallbacks({ tiers: { requiresAction: { enabled: true, sound: false }, idle: { enabled: true, osNotification: true }, progress: { enabled: true, osNotification: true }, activity: { enabled: true } } })
    new NotificationService(callbacks).notifySandbox({ kind: 'image-ready', slug: 'ws-a' })

    const [n] = dispatched(callbacks)
    expect(n).toMatchObject({ workspace: 'ws-a', tier: 'progress', summary: 'Sandbox image is ready', target: 'sandbox-chooser', source: 'sandbox' })
    expect(callbacks.showOsNotification).toHaveBeenCalledWith('Sandbox · ws-a -- Sandbox image is ready', '', 'ws-a', n.timestamp, 'sandbox-chooser')
  })

  it('image-ready: fixed title, no workspace, target sandbox-image, and a bare OS title', () => {
    const callbacks = makeCallbacks({ tiers: { requiresAction: { enabled: true, sound: false }, idle: { enabled: true, osNotification: true }, progress: { enabled: true, osNotification: true }, activity: { enabled: true } } })
    new NotificationService(callbacks).notifySandbox({ kind: 'image-ready', slug: null })

    const [n] = dispatched(callbacks)
    expect(n).toMatchObject({ workspace: '', tier: 'progress', summary: 'Sandbox image is ready', target: 'sandbox-image', source: 'sandbox' })
    expect(callbacks.showOsNotification).toHaveBeenCalledWith('Sandbox image is ready', '', '', n.timestamp, 'sandbox-image')
    expect(callbacks.unacknowledged['']).toBeUndefined()
  })
})
