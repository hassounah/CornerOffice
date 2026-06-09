import React from 'react'
import { useLocation } from 'react-router'
import { useGamificationStore } from '../../stores/gamification-store'
import { useSettingsStore } from '../../stores/settings-store'

// ---------------------------------------------------------------------------
// Trend indicator — subtle arrow
// ---------------------------------------------------------------------------

function TrendArrow({ trend }: { trend: 'up' | 'down' | 'flat' }): React.ReactElement {
  if (trend === 'up') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" className="text-emerald-400" aria-hidden="true">
        <path d="M5 2l4 6H1z" fill="currentColor" />
      </svg>
    )
  }
  if (trend === 'down') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" className="text-red-400" aria-hidden="true">
        <path d="M5 8L1 2h8z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className="text-co-text-muted" aria-hidden="true">
      <path d="M1 5h6M5 3l2 2-2 2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// TopBar — minimal, transparent, no visual weight
// ---------------------------------------------------------------------------

export function TopBar(): React.ReactElement {
  const location = useLocation()
  const isDashboard = location.pathname === '/'

  const velocity = useGamificationStore((s) => s.velocity)
  const streak = useGamificationStore((s) => s.streak)
  const companyName = useSettingsStore((s) => s.config?.companyName ?? '')
  const currentRealm = useSettingsStore((s) => s.config?.realm)

  const velocityValue = velocity?.current ?? 0
  const trend = velocity?.trend ?? 'flat'
  const streakDays = streak?.currentDays ?? 0

  return (
    <header
      className="flex items-center justify-between px-5 h-12 shrink-0 border-b border-white/[0.04]"
      role="banner"
    >
      {/* Left: breadcrumb-like context */}
      <span className="text-[13px] text-co-text-muted font-medium">
        {isDashboard ? 'Overview' : companyName || 'Corner Office'}
      </span>

      {/* Right: velocity + streak + realm toggle — understated */}
      <div className="flex items-center gap-4 ml-auto">
        {/* Velocity */}
        <div
          className="flex items-center gap-1.5"
          aria-label={`Velocity: ${velocityValue} features per month`}
        >
          <span className="text-sm font-semibold tabular-nums text-co-text-primary">
            {velocityValue}
          </span>
          <TrendArrow trend={trend} />
          <span className="text-[11px] text-co-text-muted" title="Features shipped per month">vel</span>
        </div>

        {/* Streak */}
        {streakDays > 0 ? (
          <span
            className="inline-flex items-center gap-1 text-[13px] font-medium text-amber-400/80"
            aria-label={`${streakDays}-day streak`}
          >
            <span aria-hidden="true">&#x1F525;</span>
            <span className="tabular-nums">{streakDays}d</span>
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 text-[13px] text-co-text-muted/50"
            aria-label="No active streak"
          >
            <span aria-hidden="true">&#x1F525;</span>
            <span className="tabular-nums">0d</span>
          </span>
        )}
        {/* Realm toggle */}
        <button
          type="button"
          title="Switch to CornerRealm (medieval UI)"
          aria-label="Switch to CornerRealm (medieval UI)"
          className="flex items-center justify-center w-7 h-7 rounded text-co-text-muted hover:text-co-text-primary hover:bg-white/[0.06] transition-colors"
          onClick={() => {
            void useSettingsStore.getState().updateConfig({
              realm: { ...(currentRealm ?? { enabled: false, mapping: [], shipCelebration: 'townSquare' as const }), enabled: true },
            })
          }}
        >
          {/* Castle / crown icon */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M2 13V7l2-2 2 2V5l2-2 2 2V5l2-2 2 2v6H2zm0 1h12v1H2v-1z" />
          </svg>
        </button>
      </div>
    </header>
  )
}
