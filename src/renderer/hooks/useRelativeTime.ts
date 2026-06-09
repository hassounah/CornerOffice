import { useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'

/**
 * Live-updating relative time string (e.g. "3 minutes ago").
 * Returns "--" for null input. Updates every 60 seconds.
 */
export function useRelativeTime(timestamp: string | null): string {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!timestamp) return
    const timer = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(timer)
  }, [timestamp])

  return format(timestamp)
}

function format(timestamp: string | null): string {
  if (!timestamp) return '--'
  try {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
  } catch {
    return '--'
  }
}
