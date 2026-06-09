import { create } from 'zustand'
import type { ActivityFeedItem, ActivityType } from '@main/types/events'
import type { RealmLocation, ReservedLocation } from '@main/types/config'
import type {
  CharacterRole,
  CharacterState,
  BuildingState,
  TavernFill,
  RealmOverlayId,
  OverlayContext,
  NotificationScrollContext,
  CharacterInstance,
  BuildingInstance,
} from '@main/types/realm'
import { useActivityStore } from './activity-store'
import { useWorkspaceStore } from './workspace-store'
import { useNotificationStore } from './notification-store'
import { useGamificationStore } from './gamification-store'
import { useSettingsStore } from './settings-store'
import { useTerminalStore } from './terminal-store'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARACTER_CAP = 20
const CHARACTER_IDLE_TO_TAVERN_MS = 5 * 60 * 1000  // 5 minutes
const AGING_INTERVAL_MS = 60 * 1000                 // 60 seconds

// ---------------------------------------------------------------------------
// Tool-name → character role mapping (exported for tests, case-insensitive keys)
// ---------------------------------------------------------------------------

export const TOOL_NAME_TO_ROLE: Record<string, CharacterRole> = {
  bash: 'builder',
  read: 'inspector',
  write: 'builder',
  edit: 'builder',
  grep: 'inspector',
  glob: 'inspector',
  mcp: 'wizard',
  task: 'wizard',
}

export const AGENT_TYPE_TO_ROLE: Record<string, CharacterRole> = {
  security: 'guard_left',
  backend: 'blacksmith',
  wizard: 'wizard',
  guard: 'guard_right',
  'security-architect': 'guard_left',
  'backend-architect': 'blacksmith',
}

export function deriveRole(toolName?: string, agentType?: string): CharacterRole {
  if (agentType) {
    const role = AGENT_TYPE_TO_ROLE[agentType.toLowerCase()]
    if (role) return role
  }
  if (toolName) {
    const role = TOOL_NAME_TO_ROLE[toolName.toLowerCase()]
    if (role) return role
  }
  return 'builder'
}

// ---------------------------------------------------------------------------
// Activity type → character state mapping
// ---------------------------------------------------------------------------

export function deriveCharacterState(type: ActivityType): CharacterState {
  switch (type) {
    case 'session_started':
    case 'user_prompt':
      return 'walking'
    case 'gate_passed':
    case 'review_complete':
    case 'agent_spawned':
    case 'tool_started':
    case 'tool_completed':
    case 'tool_failed':
    case 'task_completed':
      return 'working'
    case 'session_ended':
    case 'context_compacted':
    case 'pipeline_parked':
      return 'resting'
    case 'feature_shipped':
    case 'input_required': // Reuses celebrating bounce to maximize visual salience — no new CharacterState needed
      return 'celebrating'
    default:
      return 'idle'
  }
}

// ---------------------------------------------------------------------------
// Tavern fill calculation
// ---------------------------------------------------------------------------

export function deriveTavernFill(activeCount: number, totalCount: number): TavernFill {
  if (totalCount === 0) return 'packed'
  const ratio = activeCount / totalCount
  if (ratio >= 1.0) return 'empty'
  if (ratio >= 0.75) return 'sparse'
  if (ratio >= 0.5) return 'half'
  if (ratio >= 0.25) return 'full'
  return 'packed'
}

// ---------------------------------------------------------------------------
// Celebration state
// ---------------------------------------------------------------------------

export interface CelebrationState {
  active: boolean
  featureName: string | null
  workspaceSlug: string | null
  previousCharacterLocations: Record<string, RealmLocation | ReservedLocation>
}

// ---------------------------------------------------------------------------
// Realm store state & actions
// ---------------------------------------------------------------------------

type PrimaryOverlayId = Exclude<RealmOverlayId, 'notification-scroll'>
type PrimaryOverlayContext = Exclude<OverlayContext, NotificationScrollContext>

interface RealmStoreState {
  primaryOverlay: PrimaryOverlayId | null
  primaryOverlayContext: PrimaryOverlayContext | null
  notificationScrollOpen: boolean
  buildings: Record<string, BuildingInstance>
  characters: CharacterInstance[]
  tavernFill: TavernFill
  celebration: CelebrationState
  triggerElement: HTMLElement | null
  _characterIdCounter: number
  _pendingItems: ActivityFeedItem[]
  _flushScheduled: boolean

  openOverlay: (context: OverlayContext) => void
  closeOverlay: () => void
  processActivityItem: (item: ActivityFeedItem) => void
  recalculateWorldState: () => void
  triggerCelebration: (featureName: string, workspaceSlug: string | null) => void
  dismissCelebration: () => void
  ensureListeners: () => () => void
}

// ---------------------------------------------------------------------------
// Module-level state for subscription management
// ---------------------------------------------------------------------------

// Subscription generation counter — incremented on each ensureListeners() call.
// Callbacks from a previous generation will detect they're stale and no-op.
let _subscriptionGeneration = 0

// ---------------------------------------------------------------------------
// Character eviction helper (mutates array in place)
// ---------------------------------------------------------------------------

function evictCharacter(characters: CharacterInstance[]): void {
  // Evict oldest idle character first
  const idleEntries = characters
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.state === 'idle')
    .sort((a, b) => a.c.lastActiveAt - b.c.lastActiveAt)

  if (idleEntries.length > 0) {
    characters.splice(idleEntries[0].i, 1)
    return
  }

  // Fall back to evicting oldest active character
  const sorted = characters
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.createdAt - b.c.createdAt)

  if (sorted.length > 0) {
    characters.splice(sorted[0].i, 1)
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useRealmStore = create<RealmStoreState>((set, get) => ({
  primaryOverlay: null,
  primaryOverlayContext: null,
  notificationScrollOpen: false,
  buildings: {},
  characters: [],
  tavernFill: 'empty',
  celebration: {
    active: false,
    featureName: null,
    workspaceSlug: null,
    previousCharacterLocations: {},
  },
  triggerElement: null,
  _characterIdCounter: 0,
  _pendingItems: [],
  _flushScheduled: false,

  openOverlay: (context: OverlayContext) => {
    if (context.overlayId === 'notification-scroll') {
      set({ notificationScrollOpen: true })
    } else {
      const trigger = document.activeElement as HTMLElement | null
      set({
        primaryOverlay: context.overlayId as PrimaryOverlayId,
        primaryOverlayContext: context as PrimaryOverlayContext,
        triggerElement: trigger,
      })
    }
  },

  closeOverlay: () => {
    set((state) => {
      // Notification scroll is topmost — close it first, preserving any primary
      if (state.notificationScrollOpen) {
        return { notificationScrollOpen: false }
      }
      // Close primary overlay — restore focus to trigger element via microtask
      // (microtask delay ensures inert is removed from background before focus is restored)
      if (state.primaryOverlay !== null) {
        const savedTrigger = state.triggerElement
        queueMicrotask(() => savedTrigger?.focus())
        return { primaryOverlay: null, primaryOverlayContext: null, triggerElement: null }
      }
      return {}
    })
  },

  processActivityItem: (item: ActivityFeedItem) => {
    set((state) => ({ _pendingItems: [...state._pendingItems, item] }))
    if (!get()._flushScheduled) {
      set({ _flushScheduled: true })
      queueMicrotask(() => {
        set({ _flushScheduled: false })
        const items = get()._pendingItems
        set({ _pendingItems: [] })
        if (items.length === 0) return

        const config = useSettingsStore.getState().config
        if (!config) return

        const mappings = config.realm?.mapping ?? []
        const { buildings } = get()
        const newCharacters = [...get().characters]
        const now = Date.now()

        for (const activityItem of items) {
          const mapping = mappings.find((m) => m.workspaceSlug === activityItem.workspace)
          if (!mapping) continue

          const location = mapping.location as RealmLocation
          const building = buildings[location]
          if (!building || building.state === 'unassigned') continue

          const role = deriveRole(activityItem.toolName, activityItem.agentType)
          const characterState = deriveCharacterState(activityItem.type)

          // Update existing character for this workspace+role, or add new one
          const existingIdx = newCharacters.findIndex(
            (c) => c.workspaceSlug === activityItem.workspace && c.role === role
          )

          if (existingIdx >= 0) {
            newCharacters[existingIdx] = {
              ...newCharacters[existingIdx],
              state: characterState,
              lastActiveAt: now,
            }
          } else {
            if (newCharacters.length >= CHARACTER_CAP) {
              evictCharacter(newCharacters)
            }
            const counter = get()._characterIdCounter + 1
            set({ _characterIdCounter: counter })
            newCharacters.push({
              id: `char-${Date.now()}-${counter}`,
              role,
              state: characterState,
              location,
              workspaceSlug: activityItem.workspace,
              lastActiveAt: now,
              createdAt: now,
            })
          }
        }

        // Trigger celebration for any shipped events
        const shippedItem = items.find((i) => i.type === 'feature_shipped')
        if (shippedItem) {
          get().triggerCelebration(
            shippedItem.detail ?? shippedItem.title,
            shippedItem.workspace
          )
        }

        set({ characters: newCharacters })
      })
    }
  },

  recalculateWorldState: () => {
    const config = useSettingsStore.getState().config
    if (!config) return

    const workspaces = useWorkspaceStore.getState().workspaces
    const mappings = config.realm?.mapping ?? []

    // Cold-boot race protection: defer until workspace store is populated
    if (workspaces.length === 0 && mappings.some((m) => m.workspaceSlug !== null)) {
      return
    }

    // Build buildings record
    const newBuildings: Record<string, BuildingInstance> = {}
    for (const mapping of mappings) {
      const ws = workspaces.find((w) => w.slug === mapping.workspaceSlug)
      let state: BuildingState = 'unassigned'
      if (mapping.workspaceSlug) {
        state = ws ? (ws.activePipelines.length > 0 ? 'active' : 'idle') : 'unassigned'
      }
      newBuildings[mapping.location] = {
        location: mapping.location,
        workspaceSlug: mapping.workspaceSlug,
        state,
      }
    }

    // Orphan sweep: relocate characters whose location no longer has a valid workspace mapping
    const validLocations = new Set(
      mappings.filter((m) => m.workspaceSlug !== null).map((m) => m.location)
    )
    const survivingCharacters = get().characters.map((c) => {
      if (c.workspaceSlug !== null && !validLocations.has(c.location as RealmLocation)) {
        return {
          ...c,
          location: 'tavern' as ReservedLocation,
          workspaceSlug: null,
          state: 'resting' as CharacterState,
        }
      }
      return c
    })

    // Tavern fill from active/total mapped workspace ratio
    const mappedWorkspaces = mappings.filter((m) => m.workspaceSlug !== null)
    const activeCount = mappedWorkspaces.filter((m) => {
      const ws = workspaces.find((w) => w.slug === m.workspaceSlug)
      return ws !== undefined && ws.activePipelines.length > 0
    }).length
    const tavernFill = deriveTavernFill(activeCount, mappedWorkspaces.length)

    set({
      buildings: newBuildings,
      characters: survivingCharacters,
      tavernFill,
    })
  },

  triggerCelebration: (featureName: string, workspaceSlug: string | null) => {
    const characters = get().characters
    const previousLocations: Record<string, RealmLocation | ReservedLocation> = {}

    const celebratingCharacters = characters.map((c) => {
      previousLocations[c.id] = c.location as RealmLocation | ReservedLocation
      return {
        ...c,
        location: 'market_square' as ReservedLocation,
        state: 'celebrating' as CharacterState,
      }
    })

    set({
      characters: celebratingCharacters,
      celebration: {
        active: true,
        featureName,
        workspaceSlug,
        previousCharacterLocations: previousLocations,
      },
    })
  },

  dismissCelebration: () => {
    const { celebration, characters } = get()
    if (!celebration.active) return

    const restoredCharacters = characters.map((c) => {
      const prevLoc = celebration.previousCharacterLocations[c.id]
      return {
        ...c,
        location: prevLoc ?? c.location,
        state: 'idle' as CharacterState,
      }
    })

    set({
      characters: restoredCharacters,
      celebration: {
        active: false,
        featureName: null,
        workspaceSlug: null,
        previousCharacterLocations: {},
      },
    })
  },

  ensureListeners: () => {
    // Increment generation — stale callbacks from prior calls will detect and no-op
    const myGeneration = ++_subscriptionGeneration
    const isActive = () => _subscriptionGeneration === myGeneration

    // Subscribe to activity store — process new items
    const unsubActivity = useActivityStore.subscribe((state, prevState) => {
      if (!isActive()) return
      const prevIds = new Set(prevState.items.map((i) => i.id))
      const newItems = state.items.filter((item) => !prevIds.has(item.id))
      for (const item of newItems) {
        get().processActivityItem(item)
      }
    })

    // Subscribe to workspace store — recalculate world state on changes
    const unsubWorkspace = useWorkspaceStore.subscribe(() => {
      if (!isActive()) return
      get().recalculateWorldState()
    })

    // Subscribe to terminal store — spawn/remove Rix Wizard on session state changes
    const unsubTerminal = useTerminalStore.subscribe((state, prevState) => {
      if (!isActive()) return
      const config = useSettingsStore.getState().config
      if (!config) return
      const mappings = config.realm?.mapping ?? []
      const now = Date.now()

      for (const [slug, sessionState] of Object.entries(state.sessions)) {
        if (slug.startsWith('shell:')) continue
        const prevSessionState = prevState.sessions[slug] ?? 'none'
        if (sessionState === prevSessionState) continue
        const mapping = mappings.find((m) => m.workspaceSlug === slug)
        if (!mapping) continue
        const location = mapping.location as RealmLocation

        // Spawn on 'running' only (not 'starting') — avoids creating a wizard that needs
        // immediate removal if the session fails to start. Building promotion includes 'starting'.
        if (sessionState === 'running' && prevSessionState !== 'running') {
          set((s) => {
            const chars = [...s.characters]
            const existingIdx = chars.findIndex((c) => c.workspaceSlug === slug && c.role === 'wizard')
            if (existingIdx >= 0) {
              chars[existingIdx] = { ...chars[existingIdx], state: 'working', lastActiveAt: now }
              return { characters: chars }
            }
            if (chars.length >= CHARACTER_CAP) evictCharacter(chars)
            const counter = s._characterIdCounter + 1
            chars.push({
              id: `char-${now}-${counter}`,
              role: 'wizard',
              state: 'working',
              location,
              workspaceSlug: slug,
              lastActiveAt: now,
              createdAt: now,
            })
            return { characters: chars, _characterIdCounter: counter }
          })
        } else if (sessionState === 'none' && prevSessionState !== 'none') {
          set((s) => ({
            characters: s.characters.filter((c) => !(c.workspaceSlug === slug && c.role === 'wizard')),
          }))
        }
      }
    })

    // Subscribe to notification store (bell tower animation driven by components)
    const unsubNotification = useNotificationStore.subscribe(() => {
      if (!isActive()) return
      // No-op: notification bell ring is handled by RealmShell component subscription
    })

    // Subscribe to gamification store
    const unsubGamification = useGamificationStore.subscribe(() => {
      if (!isActive()) return
      // Future: gamification-driven special character events
    })

    // Deferred initial recalculate — wait until upstream stores have state
    const attemptInitialRecalculate = () => {
      if (!isActive()) return
      const workspaces = useWorkspaceStore.getState().workspaces
      const config = useSettingsStore.getState().config
      if (config !== null && workspaces !== null) {
        get().recalculateWorldState()
      }
      // If stores are not ready yet, the workspace subscribe will trigger recalculate
    }
    attemptInitialRecalculate()

    // Character aging: idle >5min → move to tavern
    const agingInterval = setInterval(() => {
      if (!isActive()) {
        clearInterval(agingInterval)
        return
      }
      const now = Date.now()
      const { characters } = get()
      const updated = characters.map((c) => {
        if (
          (c.state === 'idle' || c.state === 'resting') &&
          now - c.lastActiveAt > CHARACTER_IDLE_TO_TAVERN_MS
        ) {
          return {
            ...c,
            location: 'tavern' as ReservedLocation,
            workspaceSlug: null,
            state: 'resting' as CharacterState,
          }
        }
        return c
      })
      set({ characters: updated })
    }, AGING_INTERVAL_MS)

    // Cleanup: unsubscribe everything and reset generation guard
    return () => {
      if (_subscriptionGeneration === myGeneration) {
        // Reset so the next ensureListeners() call starts fresh
        _subscriptionGeneration = 0
      }
      unsubActivity()
      unsubWorkspace()
      unsubTerminal()
      unsubNotification()
      unsubGamification()
      clearInterval(agingInterval)
    }
  },
}))
