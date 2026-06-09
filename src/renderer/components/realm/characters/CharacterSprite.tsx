import React from 'react'
import type { CharacterInstance, CharacterState } from '@main/types/realm'
import { useSettingsStore } from '../../../stores/settings-store'
import { CHARACTER_ROLE_ASSETS } from './characterAssets'

// ---------------------------------------------------------------------------
// State-based visual modifiers
// ---------------------------------------------------------------------------

function characterFilter(state: CharacterState): string {
  switch (state) {
    case 'working':
      return 'drop-shadow(0 0 4px rgba(201,168,76,0.6))'
    case 'walking':
      return 'brightness(1.1)'
    case 'celebrating':
      return 'drop-shadow(0 0 6px rgba(255,215,100,0.9)) brightness(1.2)'
    case 'resting':
      return 'brightness(0.7) saturate(0.5)'
    case 'idle':
    default:
      return 'brightness(0.9)'
  }
}

function characterAnimation(state: CharacterState): string {
  switch (state) {
    case 'walking':
      return 'realm-bob 0.8s ease-in-out infinite'
    case 'celebrating':
      return 'realm-bounce 0.5s ease-in-out infinite'
    default:
      return 'none'
  }
}

// ---------------------------------------------------------------------------
// CharacterSprite
// ---------------------------------------------------------------------------

interface CharacterSpriteProps {
  character: CharacterInstance
}

export function CharacterSprite({ character }: CharacterSpriteProps): React.ReactElement | null {
  const animationsEnabled = useSettingsStore((s) => s.config?.realm?.animationsEnabled ?? true)
  const src = CHARACTER_ROLE_ASSETS[character.role]
  const roleLabel = character.role.replace(/_/g, ' ')
  const stateLabel = character.state
  const ariaLabel = `${roleLabel} — ${stateLabel}${character.workspaceSlug ? ` at ${character.workspaceSlug}` : ''}`

  if (!src) return null

  return (
    <img
      src={src}
      alt={ariaLabel}
      style={{
        width: 75,
        height: 80,
        objectFit: 'contain',
        filter: characterFilter(character.state),
        animation: animationsEnabled ? characterAnimation(character.state) : 'none',
        transition: 'filter 0.4s ease',
        imageRendering: 'pixelated',
        userSelect: 'none',
        pointerEvents: 'none',
      }}
    />
  )
}
