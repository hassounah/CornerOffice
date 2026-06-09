import React from 'react'
import type { WorkspaceStatus } from '@main/types/workspace'

interface StatusIconProps {
  status: WorkspaceStatus
  size?: 'sm' | 'md'
}

const COLOR_MAP: Record<WorkspaceStatus, string> = {
  active: 'bg-co-status-active shadow-[0_0_6px_rgba(52,211,153,0.4)]',
  waiting: 'bg-co-status-waiting shadow-[0_0_6px_rgba(251,191,36,0.3)]',
  parked: 'bg-co-status-parked shadow-[0_0_6px_rgba(167,139,250,0.3)]',
  attention: 'bg-co-status-attention shadow-[0_0_6px_rgba(248,113,113,0.3)]',
  idle: 'bg-co-status-idle',
}

const SIZE_MAP = {
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
}

export function StatusIcon({ status, size = 'md' }: StatusIconProps): React.ReactElement {
  return (
    <span
      className={`inline-block rounded-full shrink-0 ${COLOR_MAP[status]} ${SIZE_MAP[size]}`}
      aria-label={status}
      role="img"
    />
  )
}
