import { describe, it, expect, beforeEach } from 'vitest'
import type { NotificationItem } from '@main/types/gamification'
import { useNotificationStore } from '../../renderer/stores/notification-store'
import { hasOpenTarget } from '../../renderer/utils/notification-target'

// ---------------------------------------------------------------------------
// The in-app "Open" request (#0029 F14): it carries only what main put on the
// notice, and nothing is requested for a notice without a target.
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return { id: 'n1', tier: 'progress', workspace: 'ws', title: 't', body: '', timestamp: '2026-01-01T00:00:00Z', dismissed: false, actionLabel: null, ...overrides }
}

describe('notification-store open request', () => {
  beforeEach(() => useNotificationStore.setState({ openRequest: null }))

  it('records the workspace and target main assigned, and clears on demand', () => {
    useNotificationStore.getState().requestOpen(makeItem({ workspace: 'a', target: 'sandbox-network' }))
    expect(useNotificationStore.getState().openRequest).toEqual({ workspace: 'a', target: 'sandbox-network' })
    useNotificationStore.getState().clearOpenRequest()
    expect(useNotificationStore.getState().openRequest).toBeNull()
  })

  it('requests nothing for a notice without a target', () => {
    useNotificationStore.getState().requestOpen(makeItem())
    expect(useNotificationStore.getState().openRequest).toBeNull()
  })
})

describe('hasOpenTarget', () => {
  it.each([
    [{ workspace: 'a', target: 'sandbox-chooser' }, true],
    [{ workspace: '', target: 'sandbox-image' }, true],
    [{ workspace: '', target: 'sandbox-chooser' }, false],
    [{ workspace: 'a', target: undefined }, false],
  ])('%j is %s', (item, expected) => {
    expect(hasOpenTarget(item)).toBe(expected)
  })
})
