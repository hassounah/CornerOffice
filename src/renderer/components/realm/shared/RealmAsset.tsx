import React, { useState } from 'react'

// ---------------------------------------------------------------------------
// Asset registry — all valid realm asset identifiers
// ---------------------------------------------------------------------------

export type RealmAssetId =
  | 'map:background'
  | 'building:castle'
  | 'building:barracks'
  | 'building:library'
  | 'building:blacksmith'
  | 'building:farm'
  | 'building:merchant_house'
  | 'building:observatory'
  | 'building:stables'
  | 'building:chapel'
  | 'building:cottage'
  | 'building:tower'
  | 'building:bell_tower'
  | 'building:keep'
  | 'building:tavern'
  | 'building:market_square'
  | 'building:house_1'
  | 'building:house_2'
  | 'building:house_3'
  | 'building:house_4'
  | 'ui:lantern_lit'
  | 'ui:lantern_unlit'
  | 'homunculus:background'
  | 'homunculus:instinct_high'
  | 'homunculus:instinct_medium'
  | 'homunculus:instinct_low'
  | 'homunculus:medallion_agent'
  | 'homunculus:medallion_skill'
  | 'homunculus:medallion_command'
  | 'document:notification_scroll'

// Static imports — Vite processes these at build time
import backgroundPng from '../../../../../assets/realm/map/Background.png'
import castlePng from '../../../../../assets/realm/buildings/Castle.png'
import barracksPng from '../../../../../assets/realm/buildings/Barracks.png'
import libraryPng from '../../../../../assets/realm/buildings/Library.png'
import blacksmithPng from '../../../../../assets/realm/buildings/Blacksmith.png'
import farmPng from '../../../../../assets/realm/buildings/Farm.png'
import merchantHousePng from '../../../../../assets/realm/buildings/House.png'
import observatoryPng from '../../../../../assets/realm/buildings/Observatory.png'
import stablesPng from '../../../../../assets/realm/buildings/Stables.png'
import chapelPng from '../../../../../assets/realm/buildings/Chapel.png'
import cottagePng from '../../../../../assets/realm/buildings/Cottage.png'
import towerPng from '../../../../../assets/realm/buildings/Tower.png'
import bellTowerPng from '../../../../../assets/realm/buildings/Bell_Tower.png'
import keepPng from '../../../../../assets/realm/buildings/Keep.png'
import tavernPng from '../../../../../assets/realm/buildings/Tavern.png'
import marketSquarePng from '../../../../../assets/realm/buildings/Market_Square.png'
import house1Png from '../../../../../assets/realm/buildings/House_1.png'
import house2Png from '../../../../../assets/realm/buildings/House_2.png'
import house3Png from '../../../../../assets/realm/buildings/House_3.png'
import house4Png from '../../../../../assets/realm/buildings/House_4.png'
import lanternLitPng from '../../../../../assets/realm/ui/Lantern_Lit.png'
import lanternUnlitPng from '../../../../../assets/realm/ui/Lantern_Unlit.png'
import homunculusBgPng from '../../../../../assets/realm/homunculus/homunculus_background.png'
import instinctHighPng from '../../../../../assets/realm/homunculus/Homunculus_Instinct_High.png'
import instinctMediumPng from '../../../../../assets/realm/homunculus/Homunculus_Instinct_Medium.png'
import instinctLowPng from '../../../../../assets/realm/homunculus/Homunculus_Instinct_Low.png'
import medallionAgentPng from '../../../../../assets/realm/homunculus/Homunculus_Medalion_Agent.png'
import medallionSkillPng from '../../../../../assets/realm/homunculus/Homunculus_Medalion_Skill.png'
import medallionCommandPng from '../../../../../assets/realm/homunculus/Homunculus_Medalion_Command.png'
import notificationScrollPng from '../../../../../assets/realm/documents/Notifications_Scroll_Open.png'

const ASSET_REGISTRY: Record<RealmAssetId, string> = {
  'map:background': backgroundPng,
  'building:castle': castlePng,
  'building:barracks': barracksPng,
  'building:library': libraryPng,
  'building:blacksmith': blacksmithPng,
  'building:farm': farmPng,
  'building:merchant_house': merchantHousePng,
  'building:observatory': observatoryPng,
  'building:stables': stablesPng,
  'building:chapel': chapelPng,
  'building:cottage': cottagePng,
  'building:tower': towerPng,
  'building:bell_tower': bellTowerPng,
  'building:keep': keepPng,
  'building:tavern': tavernPng,
  'building:market_square': marketSquarePng,
  'building:house_1': house1Png,
  'building:house_2': house2Png,
  'building:house_3': house3Png,
  'building:house_4': house4Png,
  'ui:lantern_lit': lanternLitPng,
  'ui:lantern_unlit': lanternUnlitPng,
  'homunculus:background': homunculusBgPng,
  'homunculus:instinct_high': instinctHighPng,
  'homunculus:instinct_medium': instinctMediumPng,
  'homunculus:instinct_low': instinctLowPng,
  'homunculus:medallion_agent': medallionAgentPng,
  'homunculus:medallion_skill': medallionSkillPng,
  'homunculus:medallion_command': medallionCommandPng,
  'document:notification_scroll': notificationScrollPng,
}

// ---------------------------------------------------------------------------
// Error fallback types
// ---------------------------------------------------------------------------

function isBackground(id: RealmAssetId): boolean {
  return id.startsWith('map:') || id === 'homunculus:background'
}

function isBuilding(id: RealmAssetId): boolean {
  return id.startsWith('building:')
}

// ---------------------------------------------------------------------------
// RealmAsset component
// ---------------------------------------------------------------------------

interface RealmAssetProps {
  id: RealmAssetId
  alt: string
  className?: string
  style?: React.CSSProperties
  draggable?: boolean
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function RealmAsset({ id, alt, className, style, draggable = false, 'aria-hidden': ariaHidden }: RealmAssetProps): React.ReactElement | null {
  const [errored, setErrored] = useState(false)

  const src = ASSET_REGISTRY[id]

  if (errored) {
    if (isBackground(id)) {
      return (
        <div
          className={className}
          style={{ background: '#1a1209', ...style }}
          role="img"
          aria-label={alt}
          aria-hidden={ariaHidden}
        />
      )
    }
    if (isBuilding(id)) {
      return (
        <div
          className={className}
          style={{
            border: '1px dashed rgba(201,168,76,0.4)',
            borderRadius: 4,
            background: 'rgba(201,168,76,0.05)',
            ...style,
          }}
          role="img"
          aria-hidden={ariaHidden}
          aria-label={alt}
        />
      )
    }
    // Characters and UI elements — silently omit
    return null
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      draggable={draggable}
      aria-hidden={ariaHidden}
      onError={() => {
        if (import.meta.env.DEV) {
          console.warn(`[RealmAsset] Failed to load asset: ${id} (${src})`)
        }
        setErrored(true)
      }}
    />
  )
}
