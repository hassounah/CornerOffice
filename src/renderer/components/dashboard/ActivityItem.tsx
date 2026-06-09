import React from 'react'
import { useNavigate } from 'react-router'
import type { ActivityFeedItem, ActivityType } from '@main/types/events'
import { RelativeTime } from '../shared/RelativeTime'
import { useSettingsStore } from '../../stores/settings-store'

// ---------------------------------------------------------------------------
// Icon + color per activity type — uses small colored dots instead of emojis
// ---------------------------------------------------------------------------

const TYPE_CONFIG: Record<ActivityType, { icon: string; colorClass: string }> = {
  feature_shipped:   { icon: '\u2022', colorClass: 'text-emerald-400' },
  gate_passed:       { icon: '\u2022', colorClass: 'text-emerald-300' },
  review_complete:   { icon: '\u2022', colorClass: 'text-blue-400' },
  pipeline_parked:   { icon: '\u2022', colorClass: 'text-amber-400' },
  pipeline_resumed:  { icon: '\u2022', colorClass: 'text-amber-300' },
  input_required:    { icon: '\u2022', colorClass: 'text-orange-400' },
  instinct_learned:  { icon: '\u2022', colorClass: 'text-purple-400' },
  instinct_evolved:  { icon: '\u2022', colorClass: 'text-purple-300' },
  session_started:   { icon: '\u2022', colorClass: 'text-co-text-muted/50' },
  session_ended:     { icon: '\u2022', colorClass: 'text-co-text-muted/50' },
  context_compacted: { icon: '\u2022', colorClass: 'text-co-text-muted/50' },
  agent_spawned:     { icon: '\u2022', colorClass: 'text-co-text-muted/50' },
  tool_started:      { icon: '\u2022', colorClass: 'text-co-text-muted/50' },
  tool_completed:    { icon: '\u2022', colorClass: 'text-co-text-muted/50' },
  tool_failed:       { icon: '\u2022', colorClass: 'text-red-400' },
  user_prompt:       { icon: '\u2022', colorClass: 'text-blue-400' },
  task_completed:    { icon: '\u2022', colorClass: 'text-emerald-300' },
  config_changed:    { icon: '\u2022', colorClass: 'text-co-text-muted/50' },
}

interface ActivityItemProps {
  item: ActivityFeedItem
}

export function ActivityItem({ item }: ActivityItemProps): React.ReactElement {
  const navigate = useNavigate()
  const compactView = useSettingsStore((s) => s.config?.appearance.compactView ?? false)
  const { icon, colorClass } = TYPE_CONFIG[item.type] ?? { icon: '\u2022', colorClass: 'text-co-text-muted' }

  function handleClick(): void {
    navigate(`/workspace/${item.workspace}`)
  }

  if (compactView) {
    return (
      <button
        type="button"
        onClick={handleClick}
        className="w-full flex items-center gap-2.5 px-4 py-1.5 hover:bg-white/[0.03] transition-colors text-left"
        aria-label={`${item.title} — navigate to ${item.workspace}`}
      >
        <span className={`text-lg leading-none shrink-0 ${colorClass}`} aria-hidden="true">{icon}</span>
        <p className="text-[12px] text-co-text-primary truncate flex-1">{item.title}</p>
        <span className="text-[10px] text-co-text-muted/60 shrink-0">{item.workspace}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full flex gap-3 px-4 py-2.5 hover:bg-white/[0.03] transition-colors text-left"
      aria-label={`${item.title} — navigate to ${item.workspace}`}
    >
      <span className={`text-lg mt-0.5 leading-none shrink-0 ${colorClass}`} aria-hidden="true">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-co-text-primary truncate">{item.title}</p>
        {item.detail && (
          <p className="text-[11px] text-co-text-muted truncate mt-0.5">{item.detail}</p>
        )}
        <div className="flex gap-2 text-[11px] text-co-text-muted/60 mt-1">
          <span>{item.workspace}</span>
          <span className="opacity-40">&middot;</span>
          <RelativeTime timestamp={item.timestamp} />
        </div>
      </div>
    </button>
  )
}
