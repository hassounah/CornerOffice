import { useEffect } from 'react'

const ALLOWED_CHANNELS = [
  'workspace:updated',
  'workspace:statusChanged',
  'activity:newItem',
  'feature:shipped',
  'homunculus:instinctAdded',
  'homunculus:evolved',
  'gamification:updated',
  'notification:new',
  'notification:clicked',
  'main:ready',
] as const

type AllowedChannel = (typeof ALLOWED_CHANNELS)[number]

/**
 * Subscribe to a push IPC channel on mount and unsubscribe on unmount.
 * Only allowed channels (matching the preload whitelist) are accepted.
 */
export function useIpcListener(
  channel: AllowedChannel,
  callback: (...args: unknown[]) => void
): void {
  useEffect(() => {
    if (!ALLOWED_CHANNELS.includes(channel)) {
      console.warn(`[useIpcListener] Blocked channel: ${channel}`)
      return
    }
    if (!window.cornerOffice?.on) return
    const unsubscribe = window.cornerOffice.on(channel, callback)
    return () => {
      unsubscribe?.()
    }
  }, [channel, callback])
}
