import React, { useEffect } from 'react'
import { useRealmStore } from '../../../stores/realm-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { CharacterSprite } from '../characters/CharacterSprite'

const DEFAULT_CELEBRATION_DURATION_MS = 5_000

// ---------------------------------------------------------------------------
// TownSquareCelebration
// ---------------------------------------------------------------------------

export function TownSquareCelebration(): React.ReactElement {
  const celebration = useRealmStore((s) => s.celebration)
  const dismissCelebration = useRealmStore((s) => s.dismissCelebration)
  const characters = useRealmStore((s) => s.characters)
  const celebrationDurationMs = useSettingsStore(
    (s) => s.config?.realm?.celebrationDurationMs ?? DEFAULT_CELEBRATION_DURATION_MS,
  )

  // Auto-dismiss after configurable duration
  useEffect(() => {
    if (!celebration.active) return
    const timer = setTimeout(() => {
      dismissCelebration()
    }, celebrationDurationMs)
    return () => clearTimeout(timer)
  }, [celebration.active, dismissCelebration, celebrationDurationMs])

  // Characters gathered at market_square for celebration
  const celebrationChars = characters
    .filter((c) => c.location === 'market_square' || c.state === 'celebrating')
    .slice(0, 6)

  const featureName = celebration.featureName
    ? celebration.featureName.length > 60
      ? celebration.featureName.slice(0, 57) + '…'
      : celebration.featureName
    : null

  return (
    <div
      className="absolute inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={dismissCelebration}
      role="status"
      aria-live="polite"
      aria-label="Town Square Celebration — feature shipped"
    >
      <div
        className="relative p-8 rounded-lg text-center max-w-md"
        style={{
          background: '#1e140a',
          border: '2px solid rgba(201,168,76,0.6)',
          color: '#c9a84c',
          fontFamily: 'serif',
          boxShadow: '0 0 40px rgba(201,168,76,0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Character parade */}
        {celebrationChars.length > 0 && (
          <div className="flex justify-center gap-2 mb-4" aria-hidden="true">
            {celebrationChars.map((char) => (
              <CharacterSprite key={char.id} character={{ ...char, state: 'celebrating' }} />
            ))}
          </div>
        )}

        <p className="text-3xl mb-3" aria-hidden="true">🎉</p>

        <p className="text-xl mb-2" style={{ color: '#c9a84c' }}>
          Feature Shipped!
        </p>

        {featureName && (
          <p
            className="text-sm mb-4 leading-snug"
            style={{ color: '#e8d5a3' }}
          >
            {featureName}
          </p>
        )}

        {celebration.workspaceSlug && (
          <p className="text-xs" style={{ color: '#9c8a6a' }}>
            {celebration.workspaceSlug}
          </p>
        )}

        <p className="text-xs mt-4" style={{ color: 'rgba(156,138,106,0.6)' }}>
          Click to dismiss
        </p>
      </div>
    </div>
  )
}
