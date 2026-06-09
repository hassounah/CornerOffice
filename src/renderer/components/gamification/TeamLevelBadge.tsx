import React from 'react'
import type { TeamLevel } from '@main/types/workspace'

interface TeamLevelBadgeProps {
  level: TeamLevel
  compact?: boolean
}

export function TeamLevelBadge({ level, compact = false }: TeamLevelBadgeProps): React.ReactElement {
  const xpPercent =
    level.xpRequired > 0
      ? Math.min(100, Math.round((level.xpCurrent / level.xpRequired) * 100))
      : 100

  if (compact) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-co-accent/10 text-co-accent"
        aria-label={`Level ${level.number}: ${level.name}`}
      >
        Lv {level.number}
        <span className="text-[10px] opacity-60">{level.name}</span>
      </span>
    )
  }

  return (
    <div
      className="flex flex-col gap-2 p-3 rounded-co co-card min-w-[140px]"
      aria-label={`Team level: ${level.name} (Level ${level.number})`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-co-text-primary">{level.name}</span>
        <span className="text-[11px] font-mono text-co-accent tabular-nums">Lv {level.number}</span>
      </div>

      {/* XP progress bar — gradient fill */}
      <div>
        <div
          className="h-1 w-full bg-white/[0.06] rounded-full overflow-hidden"
          role="progressbar"
          aria-valuenow={level.xpCurrent}
          aria-valuemin={0}
          aria-valuemax={level.xpRequired}
          aria-label={`${level.xpCurrent} / ${level.xpRequired} XP`}
        >
          <div
            className="h-full bg-gradient-to-r from-co-accent to-co-accent-teal rounded-full transition-all duration-500"
            style={{ width: `${xpPercent}%` }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-co-text-muted/60 tabular-nums">
            {level.xpCurrent.toLocaleString()} XP
          </span>
          <span className="text-[10px] text-co-text-muted/60 tabular-nums">
            {level.xpRequired.toLocaleString()} XP
          </span>
        </div>
      </div>
    </div>
  )
}
