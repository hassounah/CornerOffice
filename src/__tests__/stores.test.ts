import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { useActivityStore } from '@renderer/stores/activity-store'
import { useHomunculusStore } from '@renderer/stores/homunculus-store'
import { useGamificationStore } from '@renderer/stores/gamification-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useNotificationStore } from '@renderer/stores/notification-store'
import type { Workspace } from '@main/types/workspace'
import type { ActivityFeedItem } from '@main/types/events'
import type { HomunculusState } from '@main/types/homunculus'
import type { GamificationState } from '@main/types/gamification'
import type { AppConfig } from '@main/types/config'
import type { NotificationItem } from '@main/types/gamification'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockOn = vi.fn(() => vi.fn()) // returns unsubscribe fn
const mockOff = vi.fn()

const mockAPI = {
  workspace: {
    getAll: vi.fn(),
    getDetail: vi.fn(),
    updateConfig: vi.fn(),
    discover: vi.fn(),
  },
  homunculus: { getState: vi.fn() },
  gamification: { getState: vi.fn() },
  activity: { getFeed: vi.fn() },
  config: { get: vi.fn(), update: vi.fn() },
  hooks: { getStatus: vi.fn(), install: vi.fn(), remove: vi.fn() },
  notifications: { getHistory: vi.fn(), dismiss: vi.fn() },
  shell: { openTerminal: vi.fn() },
  on: mockOn,
  off: mockOff,
}

Object.defineProperty(window, 'cornerOffice', {
  value: mockAPI,
  writable: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return { data, error: null }
}

function err(message: string) {
  return { data: null, error: { code: 'INTERNAL_ERROR', message } }
}

function resetAll() {
  useWorkspaceStore.setState({ workspaces: [], selectedSlug: null, loading: false, error: null })
  useActivityStore.setState({ items: [], loading: false, error: null })
  useHomunculusStore.setState({ state: null, loading: false, error: null })
  useGamificationStore.setState({ velocity: null, streak: null, workspaceLevels: {}, loading: false, error: null })
  useSettingsStore.setState({ config: null, loading: false, error: null })
  useNotificationStore.setState({ items: [], bannerStack: [], loading: false, error: null })
}

// ---------------------------------------------------------------------------
// workspace-store
// ---------------------------------------------------------------------------

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  it('fetchAll — populates workspaces on success', async () => {
    const ws = [{ slug: 'seraph', path: '/home/amer/seraph' }] as Workspace[]
    mockAPI.workspace.getAll.mockResolvedValue(ok(ws))

    await useWorkspaceStore.getState().fetchAll()

    expect(useWorkspaceStore.getState().workspaces).toEqual(ws)
    expect(useWorkspaceStore.getState().loading).toBe(false)
    expect(useWorkspaceStore.getState().error).toBeNull()
  })

  it('fetchAll — sets error on IPC error', async () => {
    mockAPI.workspace.getAll.mockResolvedValue(err('not ready'))

    await useWorkspaceStore.getState().fetchAll()

    expect(useWorkspaceStore.getState().workspaces).toEqual([])
    expect(useWorkspaceStore.getState().error).toBe('not ready')
  })

  it('fetchAll — sets error on network throw', async () => {
    mockAPI.workspace.getAll.mockRejectedValue(new Error('network error'))

    await useWorkspaceStore.getState().fetchAll()

    expect(useWorkspaceStore.getState().error).toBe('network error')
  })

  it('selectWorkspace — updates selectedSlug', () => {
    useWorkspaceStore.getState().selectWorkspace('seraph')
    expect(useWorkspaceStore.getState().selectedSlug).toBe('seraph')
  })

  it('selectWorkspace — clears selectedSlug with null', () => {
    useWorkspaceStore.getState().selectWorkspace('seraph')
    useWorkspaceStore.getState().selectWorkspace(null)
    expect(useWorkspaceStore.getState().selectedSlug).toBeNull()
  })

  it('initListeners — registers workspace:updated and workspace:statusChanged', () => {
    const cleanup = useWorkspaceStore.getState().initListeners()
    expect(mockOn).toHaveBeenCalledWith('workspace:updated', expect.any(Function))
    expect(mockOn).toHaveBeenCalledWith('workspace:statusChanged', expect.any(Function))
    cleanup()
  })

  it('initListeners — cleanup calls unsubscribe functions', () => {
    const unsub1 = vi.fn()
    const unsub2 = vi.fn()
    mockOn.mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2)
    const cleanup = useWorkspaceStore.getState().initListeners()
    cleanup()
    expect(unsub1).toHaveBeenCalled()
    expect(unsub2).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// activity-store
// ---------------------------------------------------------------------------

describe('useActivityStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  it('fetchFeed — populates items on success', async () => {
    const items = [{ id: 'a1', type: 'session_started' }] as ActivityFeedItem[]
    mockAPI.activity.getFeed.mockResolvedValue(ok({ items }))

    await useActivityStore.getState().fetchFeed()

    expect(useActivityStore.getState().items).toEqual(items)
    expect(useActivityStore.getState().loading).toBe(false)
  })

  it('fetchFeed — sets error on IPC error', async () => {
    mockAPI.activity.getFeed.mockResolvedValue(err('not ready'))

    await useActivityStore.getState().fetchFeed()

    expect(useActivityStore.getState().error).toBe('not ready')
  })

  it('fetchFeed — caps items at 2000', async () => {
    const items = Array.from({ length: 2100 }, (_, i) => ({ id: String(i), timestamp: new Date(i).toISOString() })) as ActivityFeedItem[]
    mockAPI.activity.getFeed.mockResolvedValue(ok({ items }))

    await useActivityStore.getState().fetchFeed(2100)

    expect(useActivityStore.getState().items).toHaveLength(2000)
  })

  it('initListeners — registers activity:newItem and feature:shipped', () => {
    const cleanup = useActivityStore.getState().initListeners()
    expect(mockOn).toHaveBeenCalledWith('activity:newItem', expect.any(Function))
    expect(mockOn).toHaveBeenCalledWith('feature:shipped', expect.any(Function))
    cleanup()
  })

  it('push via activity:newItem listener — prepends to items', () => {
    let capturedListener: ((...args: unknown[]) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedListener = fn
      return vi.fn()
    })
    mockOn.mockReturnValue(vi.fn())

    useActivityStore.getState().initListeners()

    const newItem = { id: 'new1', type: 'gate_passed' } as ActivityFeedItem
    capturedListener!(newItem)

    expect(useActivityStore.getState().items[0]).toEqual(newItem)
  })
})

// ---------------------------------------------------------------------------
// homunculus-store
// ---------------------------------------------------------------------------

describe('useHomunculusStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  it('fetchState — sets state on success', async () => {
    const state = { instincts: [], observations: [], evolved: [], stats: {} } as unknown as HomunculusState
    mockAPI.homunculus.getState.mockResolvedValue(ok(state))

    await useHomunculusStore.getState().fetchState()

    expect(useHomunculusStore.getState().state).toEqual(state)
    expect(useHomunculusStore.getState().loading).toBe(false)
  })

  it('fetchState — sets error on IPC error', async () => {
    mockAPI.homunculus.getState.mockResolvedValue(err('not ready'))

    await useHomunculusStore.getState().fetchState()

    expect(useHomunculusStore.getState().error).toBe('not ready')
  })

  it('initListeners — registers homunculus:instinctAdded and homunculus:evolved', () => {
    const cleanup = useHomunculusStore.getState().initListeners()
    expect(mockOn).toHaveBeenCalledWith('homunculus:instinctAdded', expect.any(Function))
    expect(mockOn).toHaveBeenCalledWith('homunculus:evolved', expect.any(Function))
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// gamification-store
// ---------------------------------------------------------------------------

describe('useGamificationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  it('fetchState — populates velocity, streak, workspaceLevels on success', async () => {
    const state: GamificationState = {
      velocity: { current: 14, sparkline: Array(28).fill(0), trend: 'up' },
      streak: { currentDays: 3, lastShipDate: '2024-01-15' },
      workspaceLevels: { seraph: { xp: 500, level: 2 } },
    }
    mockAPI.gamification.getState.mockResolvedValue(ok(state))

    await useGamificationStore.getState().fetchState()

    expect(useGamificationStore.getState().velocity).toEqual(state.velocity)
    expect(useGamificationStore.getState().streak).toEqual(state.streak)
    expect(useGamificationStore.getState().workspaceLevels).toEqual(state.workspaceLevels)
  })

  it('fetchState — sets error on IPC error', async () => {
    mockAPI.gamification.getState.mockResolvedValue(err('not ready'))

    await useGamificationStore.getState().fetchState()

    expect(useGamificationStore.getState().error).toBe('not ready')
  })

  it('initListeners — registers gamification:updated', () => {
    const cleanup = useGamificationStore.getState().initListeners()
    expect(mockOn).toHaveBeenCalledWith('gamification:updated', expect.any(Function))
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// settings-store
// ---------------------------------------------------------------------------

describe('useSettingsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  it('fetchConfig — sets config on success', async () => {
    const config = { companyName: 'Acme', version: 1 } as unknown as AppConfig
    mockAPI.config.get.mockResolvedValue(ok(config))

    await useSettingsStore.getState().fetchConfig()

    expect(useSettingsStore.getState().config).toEqual(config)
    expect(useSettingsStore.getState().loading).toBe(false)
  })

  it('fetchConfig — sets error on IPC error', async () => {
    mockAPI.config.get.mockResolvedValue(err('not ready'))

    await useSettingsStore.getState().fetchConfig()

    expect(useSettingsStore.getState().error).toBe('not ready')
  })

  it('updateConfig — updates config on success', async () => {
    const updated = { companyName: 'NewCo', version: 1 } as unknown as AppConfig
    mockAPI.config.update.mockResolvedValue(ok(updated))

    await useSettingsStore.getState().updateConfig({ companyName: 'NewCo' } as Partial<AppConfig>)

    expect(useSettingsStore.getState().config).toEqual(updated)
  })

  it('updateConfig — throws on IPC error', async () => {
    mockAPI.config.update.mockResolvedValue(err('lock timeout'))

    await expect(
      useSettingsStore.getState().updateConfig({ companyName: 'X' } as Partial<AppConfig>)
    ).rejects.toThrow('lock timeout')
  })
})

// ---------------------------------------------------------------------------
// notification-store
// ---------------------------------------------------------------------------

describe('useNotificationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  it('fetchHistory — populates items on success', async () => {
    const items = [{ id: 'n1', tier: 'activity', dismissed: false }] as NotificationItem[]
    mockAPI.notifications.getHistory.mockResolvedValue(ok({ items }))

    await useNotificationStore.getState().fetchHistory()

    expect(useNotificationStore.getState().items).toEqual(items)
  })

  it('fetchHistory — sets error on IPC error', async () => {
    mockAPI.notifications.getHistory.mockResolvedValue(err('not ready'))

    await useNotificationStore.getState().fetchHistory()

    expect(useNotificationStore.getState().error).toBe('not ready')
  })

  it('dismiss — marks item as dismissed and removes from bannerStack', async () => {
    mockAPI.notifications.dismiss.mockResolvedValue(ok({ dismissed: true }))
    useNotificationStore.setState({
      items: [{ id: 'n1', tier: 'idle', dismissed: false } as NotificationItem],
      bannerStack: [{ id: 'n1', tier: 'idle', dismissed: false } as NotificationItem],
    })

    await useNotificationStore.getState().dismiss('n1')

    expect(useNotificationStore.getState().items[0].dismissed).toBe(true)
    expect(useNotificationStore.getState().bannerStack).toHaveLength(0)
  })

  it('pushBanner — adds to bannerStack', () => {
    const item = { id: 'n1', tier: 'idle' } as NotificationItem
    useNotificationStore.getState().pushBanner(item)
    expect(useNotificationStore.getState().bannerStack).toHaveLength(1)
  })

  it('pushBanner — caps bannerStack at 3', () => {
    for (let i = 0; i < 5; i++) {
      useNotificationStore.getState().pushBanner({ id: `n${i}` } as NotificationItem)
    }
    expect(useNotificationStore.getState().bannerStack).toHaveLength(3)
  })

  it('dismissBanner — removes from bannerStack only', () => {
    useNotificationStore.setState({
      items: [{ id: 'n1' } as NotificationItem],
      bannerStack: [{ id: 'n1' } as NotificationItem, { id: 'n2' } as NotificationItem],
    })
    useNotificationStore.getState().dismissBanner('n1')
    expect(useNotificationStore.getState().bannerStack).toHaveLength(1)
    expect(useNotificationStore.getState().items).toHaveLength(1) // items unchanged
  })

  it('initListeners — registers notification:new', () => {
    const cleanup = useNotificationStore.getState().initListeners()
    expect(mockOn).toHaveBeenCalledWith('notification:new', expect.any(Function))
    cleanup()
  })

  it('notification:new push — prepends to items and bannerStack', () => {
    let capturedListener: ((...args: unknown[]) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockOn as any).mockImplementationOnce((_ch: string, fn: (...args: unknown[]) => void) => {
      capturedListener = fn
      return vi.fn()
    })

    useNotificationStore.getState().initListeners()

    const item = { id: 'n99', tier: 'requiresAction', dismissed: false } as NotificationItem
    capturedListener!(item)

    expect(useNotificationStore.getState().items[0]).toEqual(item)
    expect(useNotificationStore.getState().bannerStack[0]).toEqual(item)
  })
})
