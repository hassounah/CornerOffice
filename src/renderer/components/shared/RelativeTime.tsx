import React from 'react'
import { useRelativeTime } from '../../hooks/useRelativeTime'

interface RelativeTimeProps {
  timestamp: string | null
  className?: string
}

export function RelativeTime({ timestamp, className }: RelativeTimeProps): React.ReactElement {
  const relative = useRelativeTime(timestamp)

  return (
    <time
      dateTime={timestamp ?? undefined}
      className={className}
      title={timestamp ?? undefined}
    >
      {relative}
    </time>
  )
}
