import type { AgentId } from './descriptors'
import { getDescriptor } from './descriptors'
import { getHandler } from './registry'
import type { HostSessionObserver } from '../services/terminal-manager'
import type { NotificationService } from '../services/notification-service'

// ---------------------------------------------------------------------------
// agents/activity-tracking.ts — the "activity tracking off" state (#0037 C6,
// TRD §4.11). An agent that defines `copy.noActivity` can run without its
// Corner Office plugin; then no events arrive, so a session waiting on an
// approval prompt would be reported as "idle". While such a session runs, the
// idle-timer notification is suppressed for its workspace.
// ---------------------------------------------------------------------------

/** Whether the agent can run without activity data, and so has an "activity tracking off" state to report. */
export function hasActivityTrackingState(agentId: AgentId): boolean {
  return getDescriptor(agentId).copy.noActivity !== null
}

/** Observes host agent sessions and keeps idle notifications off for those whose plugin is unavailable. */
export function createActivityTrackingObserver(notifications: Pick<NotificationService, 'setIdleSuppressed'>): HostSessionObserver {
  /** A session's detection result only applies if it is still the latest session for the slug when it arrives. */
  const latest = new Map<string, number>()
  const bump = (slug: string): number => {
    const next = (latest.get(slug) ?? 0) + 1
    latest.set(slug, next)
    return next
  }

  return {
    started: (slug, agentId) => {
      const token = bump(slug)
      const detect = hasActivityTrackingState(agentId) ? getHandler(agentId).plugin?.detect : undefined
      if (!detect) {
        notifications.setIdleSuppressed(slug, false)
        return
      }
      detect()
        .then((status) => status.installed)
        .catch(() => false) // detect() must not throw; if it does, treat the plugin as unavailable
        .then((installed) => {
          if (latest.get(slug) === token) notifications.setIdleSuppressed(slug, !installed)
        })
        .catch(() => undefined)
    },
    ended: (slug) => {
      bump(slug)
      notifications.setIdleSuppressed(slug, false)
    },
  }
}
