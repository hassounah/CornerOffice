import React from 'react'

type PipelineType = 'direct' | 'light' | 'full'

interface PipelineTypeBadgeProps {
  type: PipelineType
}

const STYLE_MAP: Record<PipelineType, string> = {
  direct: 'bg-white/[0.06] text-co-text-secondary',
  light:  'bg-blue-500/10 text-blue-400',
  full:   'bg-co-accent/10 text-co-accent',
}

export function PipelineTypeBadge({ type }: PipelineTypeBadgeProps): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${STYLE_MAP[type]}`}
    >
      {type}
    </span>
  )
}
