import { useEffect } from 'react'
import { useSandboxStore } from '../stores/sandbox-store'

/** TRD §9.2: branch, ahead and dirty count refresh this often while a sandbox session runs. */
export const STATUS_POLL_MS = 15_000

/**
 * B-L1: with several sandboxes running, their refreshes queue behind git-runner's shared
 * semaphore. A small per-slug offset keeps them from all firing on the same tick.
 */
export function statusPollIntervalMs(slug: string): number {
  let h = 0
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return STATUS_POLL_MS + (h % 1000)
}

/**
 * Refreshes `slug`'s sandbox status every ~15 s, only while the hosting workspace view is
 * mounted and that sandbox session is running. Stops on unmount or when the session ends.
 */
export function useSandboxStatusPolling(slug: string): void {
  const running = useSandboxStore((s) => s.status[slug]?.session.state === 'running')

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void useSandboxStore.getState().fetchStatus(slug)
    }, statusPollIntervalMs(slug))
    return () => clearInterval(timer)
  }, [slug, running])
}
