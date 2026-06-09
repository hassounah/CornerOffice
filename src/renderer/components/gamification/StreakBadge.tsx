import React from 'react'
import type { StreakData } from '@main/types/gamification'

interface StreakBadgeProps {
  data: StreakData | null
}

/**
 * Flame icon + day count.
 * Orange when active (>0 days), gray when broken (0 days).
 */
export function StreakBadge({ data }: StreakBadgeProps): React.ReactElement {
  const days = data?.currentDays ?? 0
  const isActive = days > 0

  return (
    <div
      className={[
        'flex items-center gap-1.5 px-3 py-2 rounded-xl border',
        isActive
          ? 'bg-orange-900/20 border-orange-500/30 text-orange-400'
          : 'bg-co-bg-elevated border-white/[0.04] text-gray-500',
      ].join(' ')}
      aria-label={`${days}-day shipping streak${isActive ? '' : ' (broken)'}`}
    >
      {/* Flame icon */}
      <span
        className={['text-xl leading-none', isActive ? '' : 'grayscale opacity-50'].join(' ')}
        aria-hidden="true"
        role="img"
      >
        🔥
      </span>

      <div>
        <p className="text-2xl font-bold tabular-nums leading-none">{days}</p>
        <p className="text-[10px] uppercase tracking-wider opacity-70 mt-0.5">
          {days === 1 ? 'day' : 'days'}
        </p>
      </div>
    </div>
  )
}
