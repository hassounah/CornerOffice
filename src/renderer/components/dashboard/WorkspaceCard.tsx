import React from 'react'
import { useNavigate } from 'react-router'
import type { Workspace } from '@main/types/workspace'
import { StatusIcon } from '../shared/StatusIcon'
import { PulseDot } from '../shared/PulseDot'
import { RelativeTime } from '../shared/RelativeTime'
import { PipelineTypeBadge } from '../shared/PipelineTypeBadge'
import { GateDots } from '../shared/GateDots'
import { useSettingsStore } from '../../stores/settings-store'
import { UnmergedDot } from '../sandbox/UnmergedDot'
import { AVAILABILITY_BADGE } from '../../utils/workspace-errors'

interface WorkspaceCardProps {
  workspace: Workspace
}

export function WorkspaceCard({ workspace: ws }: WorkspaceCardProps): React.ReactElement {
  const navigate = useNavigate()
  const compactView = useSettingsStore((s) => s.config?.appearance.compactView ?? false)

  const isActive = ws.status === 'active'
  // A folder that is not usable right now still opens (its detail page says why), but it is muted and named.
  const badge = ws.availability === 'ok' ? null : AVAILABILITY_BADGE[ws.availability]
  const badgeNode = badge && (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-co-status-attention/15 text-co-status-attention shrink-0">{badge}</span>
  )
  const muted = badge ? 'opacity-60' : ''

  if (compactView) {
    return (
      <button
        onClick={() => navigate(`/workspace/${ws.slug}`)}
        className={[
          'w-full text-left co-card co-card-interactive px-3 py-2 flex items-center gap-2.5',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-co-accent',
          isActive ? 'co-glow-active' : '',
          muted,
        ].join(' ')}
        aria-label={`${ws.displayName} workspace`}
      >
        {isActive ? <PulseDot /> : <StatusIcon status={ws.status} size="sm" />}
        <span className="text-[13px] font-medium text-co-text-primary truncate flex-1">{ws.displayName}</span>
        {badgeNode}
        <UnmergedDot slug={ws.slug} focusable={false} />
        <span className="text-[11px] text-co-text-muted shrink-0 tabular-nums">Lv {ws.level.number}</span>
        {ws.activePipelines.map((pipeline) => (
          <PipelineTypeBadge key={pipeline.slug} type={pipeline.pipelineType} />
        ))}
      </button>
    )
  }

  return (
    <button
      onClick={() => navigate(`/workspace/${ws.slug}`)}
      className={[
        'w-full text-left co-card co-card-interactive p-4',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-co-accent',
        isActive ? 'motion-safe:co-animate-glow' : '',
        muted,
      ].join(' ')}
      aria-label={`${ws.displayName} workspace`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2.5 mb-3">
        {isActive ? <PulseDot /> : <StatusIcon status={ws.status} size="sm" />}
        <span className="font-semibold text-co-text-primary truncate flex-1 tracking-tight">
          {ws.displayName}
        </span>
        {badgeNode}
        <UnmergedDot slug={ws.slug} focusable={false} />
        <span className="text-[11px] text-co-text-muted tabular-nums font-medium">
          Lv {ws.level.number}
        </span>
      </div>

      {/* Active pipeline section */}
      {ws.activePipelines.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {ws.activePipelines.map((pipeline) => (
            <div key={pipeline.slug} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <PipelineTypeBadge type={pipeline.pipelineType} />
                {pipeline.pipelineType === 'full' && pipeline.gate !== null && (
                  <GateDots
                    passed={pipeline.gate - 1}
                    current={pipeline.gate - 1}
                  />
                )}
              </div>
              <p className="text-[12px] text-co-text-secondary truncate leading-relaxed">
                {pipeline.featureName}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Parked count */}
      {ws.parkedPipelines.length > 0 && (
        <p className="text-[11px] text-co-status-parked font-medium mb-2">
          {ws.parkedPipelines.length} parked
        </p>
      )}

      {/* Footer: activity + ships */}
      <div className="flex items-center justify-between text-[11px] text-co-text-muted mt-auto pt-3 border-t border-white/[0.04]">
        <RelativeTime timestamp={ws.lastActivityTimestamp} />
        {ws.weekShipCount > 0 && (
          <span className="text-emerald-400 font-medium">{ws.weekShipCount} shipped this week</span>
        )}
      </div>
    </button>
  )
}
