import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRealmStore, deriveRole, deriveCharacterState, deriveTavernFill, TOOL_NAME_TO_ROLE, AGENT_TYPE_TO_ROLE } from '@renderer/stores/realm-store'
import { useActivityStore } from '@renderer/stores/activity-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useNotificationStore } from '@renderer/stores/notification-store'
import { useGamificationStore } from '@renderer/stores/gamification-store'
import { useTerminalStore } from '@renderer/stores/terminal-store'
import type { ActivityFeedItem } from '@main/types/events'
import type { Workspace } from '@main/types/workspace'
import type { AppConfig, RealmLocationMapping } from '@main/types/config'

// ---------------------------------------------------------------------------
// Mock window.cornerOffice
// ---------------------------------------------------------------------------

const mockOn = vi.fn(() => vi.fn())
const mockOff = vi.fn()

const mockAPI = {
  workspace: { getAll: vi.fn(), getDetail: vi.fn(), updateConfig: vi.fn(), discover: vi.fn() },
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

Object.defineProperty(window, 'cornerOffice', { value: mockAPI, writable: true })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActivityItem(overrides: Partial<ActivityFeedItem> = {}): ActivityFeedItem {
  return {
    id: `item-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    workspace: 'test-ws',
    type: 'tool_started',
    title: 'Agent activity',
    detail: null,
    ...overrides,
  }
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/test',
    displayName: 'Test WS',
    docsRoot: '/test/docs',
    docsRootExists: true,
    status: 'idle',
    nextFeatureId: null,
    projectContext: '',
    activePipelines: [],
    parkedPipelines: [],
    features: [],
    ideationItems: [],
    shippedFeatures: [],
    lastActivityTimestamp: null,
    weekShipCount: 0,
    pinned: false,
    archived: false,
    level: { number: 1, name: 'Prototype' as const, xpRequired: 0, xpCurrent: 0 },
    xp: 0,
    readmeContent: null,
    ...overrides,
  }
}

function makeConfig(mappings: RealmLocationMapping[] = [{ workspaceSlug: 'test-ws', location: 'castle' }]): AppConfig {
  return {
    version: 2,
    companyName: 'Test',
    workspaces: [],
    notifications: {
      osNotificationsEnabled: false,
      showMissedOnStartup: true,
      tiers: {
        requiresAction: { enabled: true, sound: false },
        idle: { enabled: false, osNotification: false },
        progress: { enabled: false, osNotification: false },
        activity: { enabled: false },
      },
      idleThresholdMinutes: 5,
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
    },
    appearance: { theme: 'dark', compactView: false, shipMomentStyle: 'full' },
    hooks: { installed: false, installedAt: null, hookScriptPath: '' },
    realm: { enabled: true, mapping: mappings, shipCelebration: 'townSquare' },
    terminal: { fontSize: 14, windowBounds: {} },
    discoveryExclusions: [],
    firstLaunchComplete: true,
    terminalEmulator: null,
    hookScriptPath: '',
  }
}

function resetAll() {
  useWorkspaceStore.setState({ workspaces: [], selectedSlug: null, loading: false, error: null })
  useActivityStore.setState({ items: [], loading: false, error: null })
  useSettingsStore.setState({ config: null, loading: false, error: null })
  useNotificationStore.setState({ items: [], bannerStack: [], loading: false, error: null })
  useGamificationStore.setState({ velocity: null, streak: null, workspaceLevels: {}, loading: false, error: null })
  useTerminalStore.setState({ sessions: {}, overlayVisible: {}, spawnError: {} })
  useRealmStore.setState({
    primaryOverlay: null,
    primaryOverlayContext: null,
    notificationScrollOpen: false,
    buildings: {},
    characters: [],
    tavernFill: 'empty',
    celebration: { active: false, featureName: null, workspaceSlug: null, previousCharacterLocations: {} },
    triggerElement: null,
    _characterIdCounter: 0,
    _pendingItems: [],
    _flushScheduled: false,
  })
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('deriveRole', () => {
  it('maps toolName Bash (case-insensitive) to builder', () => {
    expect(deriveRole('Bash')).toBe('builder')
    expect(deriveRole('bash')).toBe('builder')
    expect(deriveRole('BASH')).toBe('builder')
  })

  it('maps toolName Read to inspector', () => {
    expect(deriveRole('Read')).toBe('inspector')
    expect(deriveRole('read')).toBe('inspector')
  })

  it('maps agentType security to guard_left', () => {
    expect(deriveRole(undefined, 'security')).toBe('guard_left')
    expect(deriveRole(undefined, 'Security')).toBe('guard_left')
  })

  it('maps agentType backend to blacksmith', () => {
    expect(deriveRole(undefined, 'backend')).toBe('blacksmith')
  })

  it('defaults to builder when no match', () => {
    expect(deriveRole(undefined, undefined)).toBe('builder')
    expect(deriveRole('UnknownTool')).toBe('builder')
    expect(deriveRole(undefined, 'unknown-agent')).toBe('builder')
  })

  it('prefers agentType over toolName when both present', () => {
    expect(deriveRole('Read', 'security')).toBe('guard_left')
  })

  it('TOOL_NAME_TO_ROLE and AGENT_TYPE_TO_ROLE are exported', () => {
    expect(TOOL_NAME_TO_ROLE).toBeDefined()
    expect(AGENT_TYPE_TO_ROLE).toBeDefined()
    expect(TOOL_NAME_TO_ROLE['bash']).toBe('builder')
    expect(AGENT_TYPE_TO_ROLE['security']).toBe('guard_left')
  })
})

describe('deriveCharacterState', () => {
  it('session_started → walking', () => expect(deriveCharacterState('session_started')).toBe('walking'))
  it('gate_passed → working', () => expect(deriveCharacterState('gate_passed')).toBe('working'))
  it('session_ended → resting', () => expect(deriveCharacterState('session_ended')).toBe('resting'))
  it('feature_shipped → celebrating', () => expect(deriveCharacterState('feature_shipped')).toBe('celebrating'))
  it('agent_spawned → working', () => expect(deriveCharacterState('agent_spawned')).toBe('working'))
  it('pipeline_parked → resting', () => expect(deriveCharacterState('pipeline_parked')).toBe('resting'))
  it('input_required → celebrating', () => expect(deriveCharacterState('input_required')).toBe('celebrating'))
  it('feature_shipped still → celebrating (no regression)', () => expect(deriveCharacterState('feature_shipped')).toBe('celebrating'))
  it('tool_started → working', () => expect(deriveCharacterState('tool_started')).toBe('working'))
  it('tool_completed → working', () => expect(deriveCharacterState('tool_completed')).toBe('working'))
  it('tool_failed → working', () => expect(deriveCharacterState('tool_failed')).toBe('working'))
  it('user_prompt → walking', () => expect(deriveCharacterState('user_prompt')).toBe('walking'))
  it('task_completed → working', () => expect(deriveCharacterState('task_completed')).toBe('working'))
  it('config_changed → idle', () => expect(deriveCharacterState('config_changed')).toBe('idle'))
})

describe('deriveTavernFill', () => {
  it('0 total → packed', () => expect(deriveTavernFill(0, 0)).toBe('packed'))
  it('0% active → packed', () => expect(deriveTavernFill(0, 4)).toBe('packed'))
  it('50% active → half', () => expect(deriveTavernFill(2, 4)).toBe('half'))
  it('100% active → empty', () => expect(deriveTavernFill(4, 4)).toBe('empty'))
  it('75%+ active → sparse', () => expect(deriveTavernFill(3, 4)).toBe('sparse'))
  it('25%+ active → full', () => expect(deriveTavernFill(1, 4)).toBe('full'))
})

// ---------------------------------------------------------------------------
// Store tests
// ---------------------------------------------------------------------------

describe('useRealmStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAll()
  })

  // -------------------------------------------------------------------------
  // recalculateWorldState
  // -------------------------------------------------------------------------

  describe('recalculateWorldState', () => {
    it('builds buildings record from config mappings', () => {
      useSettingsStore.setState({ config: makeConfig() })
      useWorkspaceStore.setState({
        workspaces: [makeWorkspace({ slug: 'test-ws', activePipelines: [] })],
      })

      useRealmStore.getState().recalculateWorldState()

      const { buildings } = useRealmStore.getState()
      expect(buildings['castle']).toBeDefined()
      expect(buildings['castle'].workspaceSlug).toBe('test-ws')
      expect(buildings['castle'].state).toBe('idle')
    })

    it('marks building active when workspace has activePipelines', () => {
      useSettingsStore.setState({ config: makeConfig() })
      useWorkspaceStore.setState({
        workspaces: [makeWorkspace({
          slug: 'test-ws',
          activePipelines: [{
            slug: 'test-feature',
            featureName: 'test',
            featureId: null,
            pipelineType: 'direct',
            stage: 'impl',
            gate: null,
            branch: null,
            planFile: null,
            taskList: null,
            started: '2024-01-01',
            fixCycles: 0,
            parkedAt: null,
            lastDecision: null,
          }],
        })],
      })

      useRealmStore.getState().recalculateWorldState()

      const { buildings } = useRealmStore.getState()
      expect(buildings['castle'].state).toBe('active')
    })

    it('marks building unassigned when no workspaceSlug', () => {
      useSettingsStore.setState({
        config: makeConfig([{ workspaceSlug: null as unknown as string, location: 'castle' }]),
      })
      useWorkspaceStore.setState({ workspaces: [] })

      useRealmStore.getState().recalculateWorldState()

      const { buildings } = useRealmStore.getState()
      expect(buildings['castle'].state).toBe('unassigned')
    })

    it('calculates tavernFill correctly', () => {
      useSettingsStore.setState({
        config: makeConfig([
          { workspaceSlug: 'ws-a', location: 'castle' as const },
          { workspaceSlug: 'ws-b', location: 'barracks' as const },
        ]),
      })
      useWorkspaceStore.setState({
        workspaces: [
          makeWorkspace({ slug: 'ws-a', activePipelines: [] }),
          makeWorkspace({ slug: 'ws-b', activePipelines: [] }),
        ],
      })

      useRealmStore.getState().recalculateWorldState()
      expect(useRealmStore.getState().tavernFill).toBe('packed')
    })

    it('returns early without config', () => {
      useSettingsStore.setState({ config: null })
      // Should not throw
      expect(() => useRealmStore.getState().recalculateWorldState()).not.toThrow()
    })

    it('relocates orphaned characters to tavern', () => {
      // Start with a character at 'castle'
      useRealmStore.setState({
        characters: [{
          id: 'char-1',
          role: 'builder',
          state: 'working',
          location: 'castle',
          workspaceSlug: 'old-ws',
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
        }],
      })

      // Now config has no mapping for 'old-ws'
      useSettingsStore.setState({
        config: makeConfig([{ workspaceSlug: 'other-ws', location: 'barracks' as const }]),
      })
      useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'other-ws' })] })

      useRealmStore.getState().recalculateWorldState()

      const { characters } = useRealmStore.getState()
      expect(characters[0].location).toBe('tavern')
      expect(characters[0].workspaceSlug).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // processActivityItem
  // -------------------------------------------------------------------------

  describe('processActivityItem', () => {
    it('places character at correct building based on workspace mapping', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: {
          castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' },
        },
      })

      const item = makeActivityItem({ workspace: 'test-ws', type: 'tool_started', toolName: 'Bash' })
      useRealmStore.getState().processActivityItem(item)

      // Wait for microtask flush
      await Promise.resolve()

      const { characters } = useRealmStore.getState()
      expect(characters.length).toBe(1)
      expect(characters[0].role).toBe('builder')
      expect(characters[0].location).toBe('castle')
      expect(characters[0].workspaceSlug).toBe('test-ws')
    })

    it('updates existing character instead of adding duplicate', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: {
          castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' },
        },
        characters: [{
          id: 'char-1',
          role: 'builder',
          state: 'idle',
          location: 'castle',
          workspaceSlug: 'test-ws',
          lastActiveAt: Date.now() - 10000,
          createdAt: Date.now() - 10000,
        }],
      })

      const item = makeActivityItem({ workspace: 'test-ws', type: 'gate_passed', toolName: 'Bash' })
      useRealmStore.getState().processActivityItem(item)
      await Promise.resolve()

      const { characters } = useRealmStore.getState()
      expect(characters.length).toBe(1)
      expect(characters[0].state).toBe('working')
    })

    it('skips items with no matching workspace mapping', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({ buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } } })

      const item = makeActivityItem({ workspace: 'unassigned-ws', type: 'agent_spawned' })
      useRealmStore.getState().processActivityItem(item)
      await Promise.resolve()

      expect(useRealmStore.getState().characters.length).toBe(0)
    })

    it('triggers celebration on feature_shipped', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'active' } },
      })

      const item = makeActivityItem({
        workspace: 'test-ws',
        type: 'feature_shipped',
        detail: 'My Feature',
      })
      useRealmStore.getState().processActivityItem(item)
      await Promise.resolve()

      const { celebration } = useRealmStore.getState()
      expect(celebration.active).toBe(true)
      expect(celebration.featureName).toBe('My Feature')
    })

    it('caps characters at 20 and evicts oldest idle first', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } },
      })

      // Pre-fill with 20 characters (unique roles by using different ids)
      const existing = Array.from({ length: 20 }, (_, i) => ({
        id: `char-existing-${i}`,
        role: 'inspector' as const,
        state: i === 0 ? ('idle' as const) : ('working' as const),
        location: 'castle' as const,
        workspaceSlug: 'other-ws',
        lastActiveAt: Date.now() - (20 - i) * 1000,
        createdAt: Date.now() - (20 - i) * 1000,
      }))
      useRealmStore.setState({ characters: existing })

      // Add a new character with a unique role (wizard) that doesn't exist yet
      const item = makeActivityItem({ workspace: 'test-ws', type: 'agent_spawned', agentType: 'wizard' })
      useRealmStore.getState().processActivityItem(item)
      await Promise.resolve()

      const { characters } = useRealmStore.getState()
      expect(characters.length).toBe(20)
      // The new wizard should be there
      expect(characters.some((c) => c.role === 'wizard')).toBe(true)
      // char-existing-0 (oldest idle) should be evicted
      expect(characters.some((c) => c.id === 'char-existing-0')).toBe(false)
    })

    it('batching state (_pendingItems, _flushScheduled) lives in store and resets via resetAll', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } },
      })

      // Initial state is clean
      expect(useRealmStore.getState()._pendingItems).toHaveLength(0)
      expect(useRealmStore.getState()._flushScheduled).toBe(false)

      const item = makeActivityItem({ workspace: 'test-ws', type: 'tool_started', toolName: 'Bash' })
      useRealmStore.getState().processActivityItem(item)

      // After enqueue but before microtask flush: pendingItems has 1 item and flush is scheduled
      expect(useRealmStore.getState()._pendingItems).toHaveLength(1)
      expect(useRealmStore.getState()._flushScheduled).toBe(true)

      // After microtask flush: state is cleaned up
      await Promise.resolve()
      expect(useRealmStore.getState()._pendingItems).toHaveLength(0)
      expect(useRealmStore.getState()._flushScheduled).toBe(false)
    })

    it('_characterIdCounter increments in store per new character', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } },
      })

      expect(useRealmStore.getState()._characterIdCounter).toBe(0)

      const item = makeActivityItem({ workspace: 'test-ws', type: 'tool_started', toolName: 'Bash' })
      useRealmStore.getState().processActivityItem(item)
      await Promise.resolve()

      // Counter incremented once (one new character)
      expect(useRealmStore.getState()._characterIdCounter).toBe(1)
      // Character ID format is correct
      expect(useRealmStore.getState().characters[0].id).toMatch(/^char-\d+-1$/)
    })
  })

  // -------------------------------------------------------------------------
  // Overlay navigation
  // -------------------------------------------------------------------------

  describe('openOverlay / closeOverlay', () => {
    it('openOverlay sets primaryOverlay and context for non-scroll overlay', () => {
      useRealmStore.getState().openOverlay({ overlayId: 'wizards-study', workspaceSlug: 'test' })
      const state = useRealmStore.getState()
      expect(state.primaryOverlay).toBe('wizards-study')
      expect(state.primaryOverlayContext).toMatchObject({ overlayId: 'wizards-study', workspaceSlug: 'test' })
      expect(state.notificationScrollOpen).toBe(false)
    })

    it('openOverlay sets notificationScrollOpen for notification-scroll', () => {
      useRealmStore.getState().openOverlay({ overlayId: 'notification-scroll' })
      const state = useRealmStore.getState()
      expect(state.notificationScrollOpen).toBe(true)
      expect(state.primaryOverlay).toBeNull()
    })

    it('notification-scroll stacks on top of primary overlay', () => {
      useRealmStore.getState().openOverlay({ overlayId: 'wizards-study', workspaceSlug: 'test' })
      useRealmStore.getState().openOverlay({ overlayId: 'notification-scroll' })
      const state = useRealmStore.getState()
      // Both are open simultaneously
      expect(state.primaryOverlay).toBe('wizards-study')
      expect(state.notificationScrollOpen).toBe(true)
    })

    it('closeOverlay closes notification-scroll first, preserving primary', () => {
      useRealmStore.setState({
        primaryOverlay: 'settings-chamber',
        primaryOverlayContext: { overlayId: 'settings-chamber' },
        notificationScrollOpen: true,
      })
      useRealmStore.getState().closeOverlay()
      const state = useRealmStore.getState()
      // Notification scroll closed, primary preserved
      expect(state.notificationScrollOpen).toBe(false)
      expect(state.primaryOverlay).toBe('settings-chamber')
    })

    it('closeOverlay closes primary overlay when notification-scroll is not open', () => {
      useRealmStore.setState({
        primaryOverlay: 'settings-chamber',
        primaryOverlayContext: { overlayId: 'settings-chamber' },
        notificationScrollOpen: false,
      })
      useRealmStore.getState().closeOverlay()
      expect(useRealmStore.getState().primaryOverlay).toBeNull()
    })

    it('closeOverlay is no-op when no overlay open', () => {
      useRealmStore.setState({ primaryOverlay: null, primaryOverlayContext: null, notificationScrollOpen: false })
      expect(() => useRealmStore.getState().closeOverlay()).not.toThrow()
      expect(useRealmStore.getState().primaryOverlay).toBeNull()
    })

    it('openOverlay captures document.activeElement as triggerElement for primary overlay', () => {
      const btn = document.createElement('button')
      document.body.appendChild(btn)
      btn.focus()
      expect(document.activeElement).toBe(btn)

      useRealmStore.getState().openOverlay({ overlayId: 'wizards-study', workspaceSlug: 'test' })

      expect(useRealmStore.getState().triggerElement).toBe(btn)
      document.body.removeChild(btn)
    })

    it('openOverlay does NOT set triggerElement for notification-scroll', () => {
      const btn = document.createElement('button')
      document.body.appendChild(btn)
      btn.focus()

      useRealmStore.getState().openOverlay({ overlayId: 'notification-scroll' })

      // triggerElement should remain null — notification-scroll doesn't do focus return
      expect(useRealmStore.getState().triggerElement).toBeNull()
      document.body.removeChild(btn)
    })

    it('closeOverlay restores focus to triggerElement via microtask', async () => {
      const btn = document.createElement('button')
      document.body.appendChild(btn)
      btn.focus()

      useRealmStore.getState().openOverlay({ overlayId: 'settings-chamber', initialSection: 'kingdom' })
      expect(useRealmStore.getState().triggerElement).toBe(btn)

      useRealmStore.getState().closeOverlay()

      // After microtask, focus should be restored
      await Promise.resolve()
      expect(document.activeElement).toBe(btn)

      // triggerElement should be cleared in state
      expect(useRealmStore.getState().triggerElement).toBeNull()
      document.body.removeChild(btn)
    })

    it('closeOverlay does NOT restore focus when closing notification-scroll', async () => {
      const btn = document.createElement('button')
      document.body.appendChild(btn)
      btn.focus()

      // Open primary overlay (captures trigger), then open notification-scroll on top
      useRealmStore.getState().openOverlay({ overlayId: 'settings-chamber', initialSection: 'kingdom' })
      useRealmStore.getState().openOverlay({ overlayId: 'notification-scroll' })

      // Move focus away to simulate overlay focus
      btn.blur()

      // Close notification-scroll — should NOT restore focus
      useRealmStore.getState().closeOverlay()
      await Promise.resolve()

      // Primary overlay still open; triggerElement still saved
      expect(useRealmStore.getState().notificationScrollOpen).toBe(false)
      expect(useRealmStore.getState().primaryOverlay).toBe('settings-chamber')
      expect(useRealmStore.getState().triggerElement).toBe(btn)

      document.body.removeChild(btn)
    })

    it('dismissCelebration does NOT attempt focus return', async () => {
      const btn = document.createElement('button')
      document.body.appendChild(btn)
      btn.focus()

      useRealmStore.setState({
        celebration: {
          active: true,
          featureName: 'Test Feature',
          workspaceSlug: 'test-ws',
          previousCharacterLocations: {},
        },
      })

      // Move focus away
      btn.blur()
      useRealmStore.getState().dismissCelebration()
      await Promise.resolve()

      // Focus should NOT have been restored (btn is not focused)
      expect(document.activeElement).not.toBe(btn)
      expect(useRealmStore.getState().celebration.active).toBe(false)

      document.body.removeChild(btn)
    })
  })

  // -------------------------------------------------------------------------
  // Celebration
  // -------------------------------------------------------------------------

  describe('triggerCelebration / dismissCelebration', () => {
    it('triggerCelebration sets active state and moves characters to market_square', () => {
      useRealmStore.setState({
        characters: [{
          id: 'char-1',
          role: 'builder',
          state: 'working',
          location: 'castle',
          workspaceSlug: 'test-ws',
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
        }],
      })

      useRealmStore.getState().triggerCelebration('My Feature', 'test-ws')

      const { celebration, characters } = useRealmStore.getState()
      expect(celebration.active).toBe(true)
      expect(celebration.featureName).toBe('My Feature')
      expect(characters[0].location).toBe('market_square')
      expect(characters[0].state).toBe('celebrating')
    })

    it('dismissCelebration restores character locations', () => {
      useRealmStore.setState({
        characters: [{
          id: 'char-1',
          role: 'builder',
          state: 'celebrating',
          location: 'market_square',
          workspaceSlug: 'test-ws',
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
        }],
        celebration: {
          active: true,
          featureName: 'My Feature',
          workspaceSlug: 'test-ws',
          previousCharacterLocations: { 'char-1': 'castle' },
        },
      })

      useRealmStore.getState().dismissCelebration()

      const { celebration, characters } = useRealmStore.getState()
      expect(celebration.active).toBe(false)
      expect(characters[0].location).toBe('castle')
      expect(characters[0].state).toBe('idle')
    })

    it('dismissCelebration is no-op when not active', () => {
      expect(() => useRealmStore.getState().dismissCelebration()).not.toThrow()
      expect(useRealmStore.getState().celebration.active).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // ensureListeners idempotency and toggle cycle
  // -------------------------------------------------------------------------

  describe('ensureListeners', () => {
    it('is idempotent — second call does not crash', () => {
      const cleanup1 = useRealmStore.getState().ensureListeners()
      const cleanup2 = useRealmStore.getState().ensureListeners()
      expect(() => { cleanup1(); cleanup2() }).not.toThrow()
    })

    it('cleanup unsubscribes and resets generation guard', () => {
      const cleanup = useRealmStore.getState().ensureListeners()
      expect(() => cleanup()).not.toThrow()
    })

    it('toggle cycle: on → off → on — events still drive state', async () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } },
      })

      // Turn on
      const cleanup1 = useRealmStore.getState().ensureListeners()
      // Turn off
      cleanup1()
      // Turn on again
      const cleanup2 = useRealmStore.getState().ensureListeners()

      // Simulate activity store update
      const item = makeActivityItem({ workspace: 'test-ws', type: 'tool_started', toolName: 'Bash' })
      useActivityStore.setState({ items: [item] })

      // Wait for microtask
      await Promise.resolve()

      const { characters } = useRealmStore.getState()
      expect(characters.length).toBeGreaterThan(0)

      cleanup2()
    })

    it('cleanup clears aging interval', () => {
      vi.useFakeTimers()
      const cleanup = useRealmStore.getState().ensureListeners()
      // Verify no throw on interval tick after cleanup
      cleanup()
      vi.advanceTimersByTime(120000)
      vi.useRealTimers()
    })
  })

  // -------------------------------------------------------------------------
  // Character aging
  // -------------------------------------------------------------------------

  describe('character aging', () => {
    it('idle characters older than 5min move to tavern on aging tick', () => {
      vi.useFakeTimers()

      useSettingsStore.setState({ config: makeConfig() })
      useWorkspaceStore.setState({ workspaces: [makeWorkspace()] })

      const oldIdleTime = Date.now() - 6 * 60 * 1000  // 6 minutes ago
      useRealmStore.setState({
        characters: [{
          id: 'char-aged',
          role: 'builder',
          state: 'idle',
          location: 'castle',
          workspaceSlug: 'test-ws',
          lastActiveAt: oldIdleTime,
          createdAt: oldIdleTime,
        }],
      })

      const cleanup = useRealmStore.getState().ensureListeners()

      vi.advanceTimersByTime(65000)  // Trigger aging interval

      const { characters } = useRealmStore.getState()
      expect(characters[0].location).toBe('tavern')
      expect(characters[0].workspaceSlug).toBeNull()

      cleanup()
      vi.useRealTimers()
    })
  })

  // -------------------------------------------------------------------------
  // Terminal session → wizard character
  // -------------------------------------------------------------------------

  describe('terminal session wizard', () => {
    it('spawns wizard character when terminal session transitions to running', () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({ buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } } })

      const cleanup = useRealmStore.getState().ensureListeners()

      useTerminalStore.setState({ sessions: { 'test-ws': 'running' } })

      const { characters } = useRealmStore.getState()
      expect(characters.some((c) => c.role === 'wizard' && c.workspaceSlug === 'test-ws')).toBe(true)
      expect(characters.find((c) => c.role === 'wizard')?.state).toBe('working')
      expect(characters.find((c) => c.role === 'wizard')?.location).toBe('castle')

      cleanup()
    })

    it('removes wizard character when terminal session transitions to none', () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({
        buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } },
        characters: [{
          id: 'char-wizard-1',
          role: 'wizard',
          state: 'working',
          location: 'castle',
          workspaceSlug: 'test-ws',
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
        }],
      })

      const cleanup = useRealmStore.getState().ensureListeners()

      // Start with running, then transition to none
      useTerminalStore.setState({ sessions: { 'test-ws': 'running' } })
      useTerminalStore.setState({ sessions: { 'test-ws': 'none' } })

      const { characters } = useRealmStore.getState()
      expect(characters.some((c) => c.role === 'wizard' && c.workspaceSlug === 'test-ws')).toBe(false)

      cleanup()
    })

    it('ignores shell:* sessions — no wizard created', () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({ buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } } })

      const cleanup = useRealmStore.getState().ensureListeners()

      useTerminalStore.setState({ sessions: { 'shell:my-house': 'running' } })

      const { characters } = useRealmStore.getState()
      expect(characters.some((c) => c.role === 'wizard')).toBe(false)

      cleanup()
    })

    it('prevents duplicate wizard — rapid transitions do not create two wizards', () => {
      useSettingsStore.setState({ config: makeConfig() })
      useRealmStore.setState({ buildings: { castle: { location: 'castle', workspaceSlug: 'test-ws', state: 'idle' } } })

      const cleanup = useRealmStore.getState().ensureListeners()

      // First transition to running
      useTerminalStore.setState({ sessions: { 'test-ws': 'running' } })
      // Simulate a no-op update that keeps running state
      useTerminalStore.setState({ sessions: { 'test-ws': 'running' } })

      const { characters } = useRealmStore.getState()
      expect(characters.filter((c) => c.role === 'wizard' && c.workspaceSlug === 'test-ws').length).toBe(1)

      cleanup()
    })
  })
})
