import React from 'react'
import type { RealmLocation, ReservedLocation } from '@main/types/config'
import type { BuildingState } from '@main/types/realm'
import { useSettingsStore } from '../../../stores/settings-store'
import type { RealmAssetId } from '../shared/RealmAsset'
import { RealmAsset } from '../shared/RealmAsset'

// ---------------------------------------------------------------------------
// Location → asset ID mapping
// ---------------------------------------------------------------------------

const LOCATION_TO_ASSET: Record<RealmLocation | ReservedLocation, RealmAssetId> = {
  castle: 'building:castle',
  barracks: 'building:barracks',
  library: 'building:library',
  blacksmith: 'building:blacksmith',
  farm: 'building:farm',
  merchant_house: 'building:merchant_house',
  observatory: 'building:observatory',
  stables: 'building:stables',
  chapel: 'building:chapel',
  cottage: 'building:cottage',
  tower: 'building:tower',
  bell_tower: 'building:bell_tower',
  keep: 'building:keep',
  tavern: 'building:tavern',
  market_square: 'building:market_square',
}

const LOCATION_LABEL: Record<RealmLocation | ReservedLocation, string> = {
  castle: 'The Castle',
  barracks: 'The Barracks',
  library: 'The Library',
  blacksmith: 'The Blacksmith',
  farm: 'The Farm',
  merchant_house: 'Merchant House',
  observatory: 'The Observatory',
  stables: 'The Stables',
  chapel: 'The Chapel',
  cottage: 'The Cottage',
  tower: 'The Tower',
  bell_tower: 'The Bell Tower',
  keep: 'The Keep',
  tavern: 'The Tavern',
  market_square: 'Market Square',
}

// ---------------------------------------------------------------------------
// State-based styles
// ---------------------------------------------------------------------------

const GLOW_OVERLAY_CSS = `
@keyframes glow-pulse {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.08); }
}
`

function buildingFilter(state: BuildingState | 'reserved' | 'attention'): string {
  switch (state) {
    case 'active':
      return 'drop-shadow(0 0 8px rgba(201,168,76,0.8))'
    case 'idle':
      return 'drop-shadow(0 0 4px rgba(201,168,76,0.3)) brightness(0.85)'
    case 'unassigned':
      return 'brightness(0.4) saturate(0.3)'
    case 'reserved':
      return 'drop-shadow(0 0 4px rgba(201,168,76,0.4))'
    case 'attention':
      return 'drop-shadow(0 0 6px rgba(245,158,11,0.6))'
  }
}

function buildingOpacity(state: BuildingState | 'reserved' | 'attention'): number {
  return state === 'unassigned' ? 0.7 : 1
}

// ---------------------------------------------------------------------------
// BuildingSprite
// ---------------------------------------------------------------------------

interface BuildingSpriteProps {
  location: RealmLocation | ReservedLocation
  buildingState: BuildingState | 'reserved' | 'attention'
  workspaceSlug: string | null
  onClick?: () => void
  /** Human-readable purpose shown in aria-label (e.g. "click to open workspace") */
  actionLabel?: string
}

export function BuildingSprite({
  location,
  buildingState,
  workspaceSlug,
  onClick,
  actionLabel,
}: BuildingSpriteProps): React.ReactElement {
  const animationsEnabled = useSettingsStore((s) => s.config?.realm?.animationsEnabled ?? true)
  const label = LOCATION_LABEL[location]
  const assetId = LOCATION_TO_ASSET[location]
  const isInteractive = buildingState !== 'unassigned' && onClick !== undefined
  const isUnassigned = buildingState === 'unassigned'

  const ariaLabel = isUnassigned
    ? `${label} — No workspace assigned`
    : workspaceSlug
      ? `${label} — ${workspaceSlug}${actionLabel ? ` (${actionLabel})` : ''}`
      : `${label}${actionLabel ? ` (${actionLabel})` : ''}`

  const imgStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    filter: buildingFilter(buildingState),
    opacity: buildingOpacity(buildingState),
    cursor: isInteractive ? 'pointer' : 'default',
    transition: animationsEnabled ? 'filter 0.3s ease, opacity 0.3s ease' : 'none',
    userSelect: 'none',
  }

  const focusRingClass = isInteractive
    ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a84c] focus-visible:ring-offset-1'
    : ''

  if (isInteractive) {
    return (
      <button
        type="button"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
          }
        }}
        aria-label={ariaLabel}
        className={`relative block p-0 bg-transparent border-0 rounded ${focusRingClass}`}
        style={{ lineHeight: 0 }}
      >
        {animationsEnabled && buildingState === 'attention' && <GlowOverlay />}
        <RealmAsset id={assetId} alt="" aria-hidden="true" style={imgStyle} />
        <LanternIndicator active={buildingState === 'active'} />
      </button>
    )
  }

  return (
    <div
      aria-label={ariaLabel}
      role="img"
      tabIndex={-1}
      className="relative"
    >
      {animationsEnabled && buildingState === 'attention' && <GlowOverlay />}
      <RealmAsset id={assetId} alt="" aria-hidden="true" style={imgStyle} />
      <LanternIndicator active={buildingState === 'active' || buildingState === 'reserved'} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Glow overlay — pulses behind building sprite, travels with parent container
// ---------------------------------------------------------------------------

function GlowOverlay(): React.ReactElement {
  return (
    <>
      <style>{GLOW_OVERLAY_CSS}</style>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: '-20%',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(245,158,11,0.6) 0%, rgba(245,158,11,0) 70%)',
          animation: 'glow-pulse 1.8s ease-in-out infinite',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Lantern indicator (top-right corner of building sprite)
// ---------------------------------------------------------------------------

function LanternIndicator({ active }: { active: boolean }): React.ReactElement {
  return (
    <RealmAsset
      id={active ? 'ui:lantern_lit' : 'ui:lantern_unlit'}
      alt=""
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 2,
        right: 2,
        width: 16,
        height: 20,
        objectFit: 'contain',
        opacity: active ? 1 : 0.5,
      }}
    />
  )
}
