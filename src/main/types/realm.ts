import type { RealmLocation, ReservedLocation } from './config'

// ---------------------------------------------------------------------------
// Character types
// ---------------------------------------------------------------------------

export type CharacterRole =
  | 'builder'
  | 'inspector'
  | 'guard_left'
  | 'guard_right'
  | 'blacksmith'
  | 'wizard'

export type CharacterState =
  | 'idle'
  | 'working'
  | 'walking'
  | 'celebrating'
  | 'resting'

// ---------------------------------------------------------------------------
// Building types
// ---------------------------------------------------------------------------

export type BuildingState = 'active' | 'idle' | 'unassigned'

export type TavernFill = 'empty' | 'sparse' | 'half' | 'full' | 'packed'

// ---------------------------------------------------------------------------
// Overlay types
// ---------------------------------------------------------------------------

export type RealmOverlayId =
  | 'wizards-study'
  | 'settings-chamber'
  | 'tower'
  | 'notification-scroll'

export type SettingsSectionId =
  | 'kingdom'
  | 'workspaces'
  | 'hooks'
  | 'notifications'
  | 'appearance'

export interface WizardsStudyContext {
  overlayId: 'wizards-study'
  workspaceSlug: string | null
}

export interface SettingsChamberContext {
  overlayId: 'settings-chamber'
  initialSection?: SettingsSectionId
}

export interface TowerContext {
  overlayId: 'tower'
}

export interface NotificationScrollContext {
  overlayId: 'notification-scroll'
}

export type OverlayContext =
  | WizardsStudyContext
  | SettingsChamberContext
  | TowerContext
  | NotificationScrollContext

// ---------------------------------------------------------------------------
// Instance types
// ---------------------------------------------------------------------------

export interface CharacterInstance {
  id: string
  role: CharacterRole
  state: CharacterState
  location: RealmLocation | ReservedLocation
  workspaceSlug: string | null   // null when in tavern/ambient
  lastActiveAt: number           // Date.now() ms
  createdAt: number              // Date.now() ms
}

export interface BuildingInstance {
  location: RealmLocation
  workspaceSlug: string | null   // null = unassigned
  state: BuildingState
}
