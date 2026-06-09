import React, { useCallback, useEffect } from 'react'
import type { RealmLocation, ReservedLocation } from '@main/types/config'
import type { BuildingState, CharacterInstance } from '@main/types/realm'
import { useRealmStore } from '../../../stores/realm-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { useTerminalStore } from '../../../stores/terminal-store'
import { RealmAsset } from '../shared/RealmAsset'
import { RealmTooltip } from '../shared/RealmTooltip'
import { BuildingSprite } from '../buildings/BuildingSprite'
import { CharacterSprite } from '../characters/CharacterSprite'
import { TerminalOverlay } from '../../terminal/TerminalOverlay'
import {
  interactiveBuildingPositions,
  ambientPositions,
  type AmbientLocation,
  CHARACTER_OFFSET_PX,
} from '../buildings/buildingPositions'

// ---------------------------------------------------------------------------
// All interactive locations rendered on the map
// ---------------------------------------------------------------------------

const REALM_LOCATIONS: RealmLocation[] = [
  'castle', 'barracks', 'library', 'blacksmith', 'farm',
  'merchant_house', 'observatory', 'stables', 'chapel', 'cottage',
]

const RESERVED_LOCATIONS: ReservedLocation[] = [
  'tower', 'bell_tower', 'keep', 'tavern', 'market_square',
]

const AMBIENT_LOCATIONS: AmbientLocation[] = ['house_1', 'house_2', 'house_3', 'house_4']

const AMBIENT_ASSET_IDS = {
  house_1: 'building:house_1',
  house_2: 'building:house_2',
  house_3: 'building:house_3',
  house_4: 'building:house_4',
} as const

// ---------------------------------------------------------------------------
// Reserved location label for aria
// ---------------------------------------------------------------------------

const RESERVED_ACTION: Record<ReservedLocation, string> = {
  tower: 'click to open Homunculus instincts',
  bell_tower: 'click to open notifications',
  keep: 'click to open settings',
  tavern: '',
  market_square: '',
}

// ---------------------------------------------------------------------------
// Characters grouped by location
// ---------------------------------------------------------------------------

function groupCharactersByLocation(
  characters: CharacterInstance[],
): Map<string, CharacterInstance[]> {
  const map = new Map<string, CharacterInstance[]>()
  for (const char of characters) {
    const key = char.location
    const existing = map.get(key) ?? []
    existing.push(char)
    map.set(key, existing)
  }
  return map
}

// ---------------------------------------------------------------------------
// KingdomMap
// ---------------------------------------------------------------------------

export function KingdomMap(): React.ReactElement {
  const buildings = useRealmStore((s) => s.buildings)
  const characters = useRealmStore((s) => s.characters)
  const openOverlay = useRealmStore((s) => s.openOverlay)
  const realmConfig = useSettingsStore((s) => s.config?.realm)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  const attentionSlugs = React.useMemo(() => {
    const set = new Set<string>()
    for (const ws of workspaces) {
      if (ws.status === 'attention') set.add(ws.slug)
    }
    return set
  }, [workspaces])

  const charactersByLocation = groupCharactersByLocation(characters)

  // Build a slug→location reverse map for wizards-study context
  const mappingByLocation = React.useMemo(() => {
    const m: Record<string, string | null> = {}
    for (const entry of realmConfig?.mapping ?? []) {
      m[entry.location] = entry.workspaceSlug
    }
    return m
  }, [realmConfig?.mapping])

  const [activeShellHouse, setActiveShellHouse] = React.useState<AmbientLocation | null>(null)

  const shellSessions = useTerminalStore((s) => s.sessions)
  const shellOverlayVisible = useTerminalStore((s) => s.overlayVisible)
  const { spawnShell, showOverlay, hideOverlay } = useTerminalStore()
  const terminalFontSize = useSettingsStore((s) => s.config?.terminal?.fontSize ?? 14)
  const terminalShellBounds = useSettingsStore((s) => s.config?.terminal?.windowBounds?.shell)
  const updateConfig = useSettingsStore((s) => s.updateConfig)

  // Clear activeShellHouse when a shell session exits externally (H2 review fix)
  useEffect(() => {
    const unsub = window.cornerOffice.on('terminal:exited', (payload: unknown) => {
      const { workspaceSlug } = payload as { workspaceSlug: string }
      if (workspaceSlug.startsWith('shell:')) {
        setActiveShellHouse((current) => {
          if (current && `shell:${current}` === workspaceSlug) return null
          return current
        })
      }
    })
    return unsub
  }, [])

  function handleHouseClick(houseId: AmbientLocation): void {
    const sessionKey = `shell:${houseId}`
    const state = shellSessions[sessionKey] ?? 'none'

    if (state === 'none') {
      setActiveShellHouse(houseId)
      void spawnShell(houseId)
    } else if (state === 'running' || state === 'starting') {
      const isVisible = shellOverlayVisible[sessionKey] ?? false
      if (activeShellHouse === houseId && isVisible) {
        hideOverlay(sessionKey)
        setActiveShellHouse(null)
      } else {
        if (activeShellHouse && activeShellHouse !== houseId) {
          hideOverlay(`shell:${activeShellHouse}`)
        }
        showOverlay(sessionKey)
        setActiveShellHouse(houseId)
      }
    }
  }

  const handleRealmLocationClick = useCallback(
    (location: RealmLocation) => {
      const slug = mappingByLocation[location] ?? null
      if (slug) {
        openOverlay({ overlayId: 'wizards-study', workspaceSlug: slug })
      }
    },
    [mappingByLocation, openOverlay],
  )

  const handleReservedLocationClick = useCallback(
    (location: ReservedLocation) => {
      if (location === 'tower') {
        openOverlay({ overlayId: 'tower' })
      } else if (location === 'bell_tower') {
        openOverlay({ overlayId: 'notification-scroll' })
      } else if (location === 'keep') {
        openOverlay({ overlayId: 'settings-chamber', initialSection: 'kingdom' })
      }
      // tavern and market_square have no click action
    },
    [openOverlay],
  )

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ background: '#1a1209' }}
      role="region"
      aria-label="Kingdom Map"
    >
      {/* Base map background */}
      <RealmAsset
        id="map:background"
        alt=""
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          pointerEvents: 'none',
        }}
      />

      {/* Ambient houses — clickable shell terminals */}
      {AMBIENT_LOCATIONS.map((loc) => {
        const pos = ambientPositions[loc]
        const assetId = AMBIENT_ASSET_IDS[loc]
        const sessionKey = `shell:${loc}`
        const sessionState = shellSessions[sessionKey] ?? 'none'
        const houseLabel = loc.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
        const tooltip = sessionState === 'running' ? `${houseLabel} — shell active`
          : sessionState === 'starting' ? `${houseLabel} — starting shell...`
          : `${houseLabel} — click to open shell`

        return (
          <div
            key={loc}
            role="button"
            tabIndex={0}
            aria-label={tooltip}
            onClick={() => handleHouseClick(loc)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleHouseClick(loc) } }}
            style={{
              position: 'absolute',
              left: `${pos.left}%`,
              top: `${pos.top}%`,
              width: `${pos.width}%`,
              height: `${pos.height}%`,
              cursor: 'pointer',
            }}
          >
            <RealmTooltip label={tooltip}>
              <RealmAsset
                id={assetId}
                alt=""
                style={{
                  width: '100%', height: '100%', objectFit: 'contain',
                  opacity: sessionState === 'running' ? 1 : sessionState === 'starting' ? 0.9 : 0.75,
                  filter: sessionState === 'running' ? 'drop-shadow(0 0 6px rgba(201,168,76,0.5))' : 'none',
                  animation: sessionState === 'starting' ? 'co-house-pulse 1.5s ease-in-out infinite' : undefined,
                  transition: 'opacity 0.3s, filter 0.3s',
                }}
              />
            </RealmTooltip>
          </div>
        )
      })}

      {/* Reserved locations */}
      {RESERVED_LOCATIONS.map((loc) => {
        const pos = interactiveBuildingPositions[loc]
        const isClickable = loc !== 'tavern' && loc !== 'market_square'
        const charsHere = charactersByLocation.get(loc) ?? []

        // Tavern tooltip: "X characters resting — Y workspaces idle"
        const tavernCharsResting = loc === 'tavern'
          ? (charactersByLocation.get('tavern') ?? []).length
          : 0
        const idleBuildingCount = loc === 'tavern'
          ? Object.values(buildings).filter((b) => b.state === 'idle').length
          : 0
        const tavernTooltip = loc === 'tavern'
          ? `${tavernCharsResting} character${tavernCharsResting !== 1 ? 's' : ''} resting — ${idleBuildingCount} workspace${idleBuildingCount !== 1 ? 's' : ''} idle`
          : ''

        const sprite = (
          <BuildingSprite
            location={loc}
            buildingState="reserved"
            workspaceSlug={null}
            onClick={isClickable ? () => handleReservedLocationClick(loc) : undefined}
            actionLabel={RESERVED_ACTION[loc] || undefined}
          />
        )

        return (
          <div
            key={loc}
            style={{ position: 'absolute', left: `${pos.left}%`, top: `${pos.top}%`, width: `${pos.width}%`, height: `${pos.height}%` }}
          >
            {isClickable ? (
              <RealmTooltip label={RESERVED_ACTION[loc]}>
                {sprite}
              </RealmTooltip>
            ) : loc === 'tavern' ? (
              <RealmTooltip label={tavernTooltip}>
                {sprite}
              </RealmTooltip>
            ) : sprite}

            {/* Characters at this reserved location */}
            {charsHere.slice(0, 3).map((char, i) => (
              <div
                key={char.id}
                style={{
                  position: 'absolute',
                  left: CHARACTER_OFFSET_PX.left + i * CHARACTER_OFFSET_PX.spacing,
                  top: CHARACTER_OFFSET_PX.top,
                }}
              >
                <CharacterSprite character={char} />
              </div>
            ))}
          </div>
        )
      })}

      {/* Assignable RealmLocation buildings */}
      {REALM_LOCATIONS.map((loc) => {
        const pos = interactiveBuildingPositions[loc]
        const building = buildings[loc]
        const slug = mappingByLocation[loc] ?? null
        // If a workspace is assigned, ensure state is at least 'idle' (clickable),
        // even if the workspace store hasn't populated yet
        const rawState: BuildingState = building?.state ?? 'unassigned'
        const baseState: BuildingState = slug ? (rawState === 'unassigned' ? 'idle' : rawState) : 'unassigned'

        // Promote to 'active' if a terminal session is running for this workspace
        const terminalState = shellSessions[slug ?? ''] ?? 'none'
        const effectiveBase: BuildingState = (
          baseState === 'idle' && (terminalState === 'running' || terminalState === 'starting')
        ) ? 'active' : baseState

        const state = slug && attentionSlugs.has(slug) ? 'attention' : effectiveBase
        const isAssigned = slug !== null
        const charsHere = charactersByLocation.get(loc) ?? []

        const sprite = (
          <BuildingSprite
            location={loc}
            buildingState={state}
            workspaceSlug={slug}
            onClick={isAssigned ? () => handleRealmLocationClick(loc) : undefined}
            actionLabel={isAssigned ? 'click to open' : undefined}
          />
        )

        return (
          <div
            key={loc}
            style={{ position: 'absolute', left: `${pos.left}%`, top: `${pos.top}%`, width: `${pos.width}%`, height: `${pos.height}%` }}
          >
            {isAssigned ? (
              <RealmTooltip label={slug ?? ''}>
                {sprite}
              </RealmTooltip>
            ) : (
              <RealmTooltip label="No workspace assigned">
                {sprite}
              </RealmTooltip>
            )}

            {/* Characters at this location (px offset, within building bounds) */}
            {charsHere.slice(0, 3).map((char, i) => (
              <div
                key={char.id}
                style={{
                  position: 'absolute',
                  left: CHARACTER_OFFSET_PX.left + i * CHARACTER_OFFSET_PX.spacing,
                  top: CHARACTER_OFFSET_PX.top,
                }}
              >
                <CharacterSprite character={char} />
              </div>
            ))}
          </div>
        )
      })}
      {/* Shell house pulse animation */}
      <style>{`
        @keyframes co-house-pulse { 0%, 100% { opacity: 0.9; } 50% { opacity: 0.5; } }
      `}</style>

      {/* Shell terminal overlay — renders over the map when a house session is active */}
      {activeShellHouse && (() => {
        const sessionKey = `shell:${activeShellHouse}`
        const sessionState = shellSessions[sessionKey] ?? 'none'
        const isVisible = shellOverlayVisible[sessionKey] ?? false
        if (!isVisible || (sessionState !== 'starting' && sessionState !== 'running')) return null
        const houseLabel = activeShellHouse.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
        return (
          <TerminalOverlay
            workspaceSlug={sessionKey}
            workspaceName=""
            label={houseLabel}
            fontSize={terminalFontSize}
            windowBounds={terminalShellBounds}
            onBoundsChange={(bounds) => {
              void updateConfig({ terminal: { windowBounds: { shell: bounds } } } as Parameters<typeof updateConfig>[0])
            }}
            onHide={() => {
              hideOverlay(sessionKey)
              setActiveShellHouse(null)
            }}
          />
        )
      })()}
    </div>
  )
}
