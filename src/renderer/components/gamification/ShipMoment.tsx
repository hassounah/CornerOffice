import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityFeedItem } from '@main/types/events'
import { useSettingsStore } from '../../stores/settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShipBatch {
  items: ActivityFeedItem[]
  /** ISO timestamp of first item in batch */
  firstAt: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_WINDOW_MS = 5_000
const DISPLAY_DURATION_MS = 3_000
const MAX_QUEUE_DEPTH = 5

// ---------------------------------------------------------------------------
// ShipMomentCard — renders a single batch
// ---------------------------------------------------------------------------

interface ShipMomentCardProps {
  batch: ShipBatch
  style: 'full' | 'compact'
}

function ShipMomentCard({ batch, style }: ShipMomentCardProps): React.ReactElement {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const isMulti = batch.items.length > 1
  const first = batch.items[0]!

  // Resolve display name for single ship
  const ws = workspaces.find((w) => w.slug === first.workspace)
  const workspaceLabel = ws?.displayName ?? first.workspace

  // For single ship: get quality score from most recent shipped feature
  const latestShipped = ws?.shippedFeatures[0]
  const qualityScore = latestShipped?.qualityScore ?? null
  const pipelineType = latestShipped?.pipelineType ?? null

  if (style === 'compact') {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={[
          'flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl',
          'bg-co-bg-elevated/90 border border-co-ship-gold/40 backdrop-blur-md',
          'motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:duration-300',
        ].join(' ')}
      >
        <span className="text-2xl" aria-hidden="true">🚀</span>
        <div className="min-w-0">
          {isMulti ? (
            <p className="text-sm font-semibold text-co-ship-gold">{batch.items.length} features shipped!</p>
          ) : (
            <>
              <p className="text-sm font-semibold text-co-ship-gold truncate">
                {first.detail ?? first.workspace}
              </p>
              <p className="text-xs text-co-text-muted truncate">{workspaceLabel}</p>
            </>
          )}
        </div>
      </div>
    )
  }

  // Full overlay
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={[
        'flex flex-col items-center justify-center gap-6 text-center px-8',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300',
      ].join(' ')}
    >
      {/* Ship emoji */}
      <span className="text-7xl motion-safe:animate-bounce" aria-hidden="true">🚀</span>

      {isMulti ? (
        <>
          <h2 className="text-3xl font-bold text-co-ship-gold">
            {batch.items.length} Features Shipped!
          </h2>
          <ul className="flex flex-col gap-1 max-h-40 overflow-y-auto w-full max-w-sm">
            {batch.items.map((item) => (
              <li key={item.id} className="text-sm text-co-text-secondary truncate">
                {item.detail ?? item.workspace}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="text-3xl font-bold text-co-ship-gold">Shipped!</h2>
            <p className="text-xl font-medium text-co-text-primary truncate max-w-sm">
              {first.detail ?? first.workspace}
            </p>
            <p className="text-sm text-co-text-muted">{workspaceLabel}</p>
          </div>

          {/* Metadata row */}
          <div className="flex items-center gap-4 text-sm text-co-text-secondary">
            {pipelineType && (
              <span className="capitalize">{pipelineType} pipeline</span>
            )}
            {qualityScore !== null && (
              <span>Quality: {qualityScore}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ShipMomentOverlay — manages queue + display lifecycle
// ---------------------------------------------------------------------------

export function ShipMomentOverlay(): React.ReactElement | null {
  const shipMomentStyle = useSettingsStore((s) => s.config?.appearance.shipMomentStyle ?? 'full')
  const realmEnabled = useSettingsStore((s) => s.config?.realm?.enabled ?? false)
  const [{ current }, setMoment] = useState<{ current: ShipBatch | null; queue: ShipBatch[] }>({ current: null, queue: [] })

  // Batch window: buffer incoming events for BATCH_WINDOW_MS
  const batchRef = useRef<ActivityFeedItem[]>([])
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Display timer for auto-dismiss
  const displayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flush accumulated batch items into the queue (or show immediately if idle)
  const flushBatch = useCallback(() => {
    const items = batchRef.current
    batchRef.current = []
    batchTimerRef.current = null
    if (items.length === 0) return
    const batch: ShipBatch = { items, firstAt: items[0]!.timestamp }
    setMoment((prev) => {
      if (prev.current === null) {
        return { current: batch, queue: prev.queue }
      }
      if (prev.queue.length >= MAX_QUEUE_DEPTH) return prev
      return { current: prev.current, queue: [...prev.queue, batch] }
    })
  }, [])

  // Receive incoming ship events
  const handleShip = useCallback((payload: unknown) => {
    if (shipMomentStyle === 'off') return
    const item = payload as ActivityFeedItem
    batchRef.current.push(item)
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushBatch, BATCH_WINDOW_MS)
    }
  }, [shipMomentStyle, flushBatch])

  // Subscribe to feature:shipped IPC
  useEffect(() => {
    if (typeof window.cornerOffice?.on !== 'function') return
    const unsub = window.cornerOffice.on('feature:shipped', handleShip)
    return () => {
      unsub()
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current)
    }
  }, [handleShip])

  // Advance to next queued batch, or clear current
  const advanceQueue = useCallback(() => {
    setMoment((prev) => {
      if (prev.queue.length > 0) {
        const [next, ...rest] = prev.queue
        return { current: next!, queue: rest }
      }
      return { current: null, queue: prev.queue }
    })
    if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
  }, [])

  const dismiss = useCallback(() => {
    advanceQueue()
  }, [advanceQueue])

  // Auto-dismiss current after display duration, then advance
  useEffect(() => {
    if (!current) return
    if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    displayTimerRef.current = setTimeout(advanceQueue, DISPLAY_DURATION_MS)
    return () => {
      if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    }
  }, [current, advanceQueue])

  // Escape key dismisses
  useEffect(() => {
    if (!current) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [current, dismiss])

  if (!current || shipMomentStyle === 'off' || realmEnabled) return null

  if (shipMomentStyle === 'compact') {
    return (
      <div
        className="fixed bottom-4 right-4 z-50 w-72"
        data-testid="ship-moment-compact"
      >
        <ShipMomentCard batch={current} style="compact" />
        <button
          onClick={dismiss}
          className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full text-co-text-muted hover:text-co-text-primary text-xs"
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
    )
  }

  // Full overlay
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      data-testid="ship-moment-full"
      onClick={dismiss}
    >
      <div onClick={(e) => e.stopPropagation()} className="relative">
        <button
          onClick={dismiss}
          className="absolute -top-2 -right-2 w-8 h-8 flex items-center justify-center rounded-full bg-co-bg-elevated text-co-text-muted hover:text-co-text-primary text-lg border border-white/[0.06]"
          aria-label="Dismiss celebration"
        >
          &times;
        </button>
        <ShipMomentCard batch={current} style="full" />
      </div>
    </div>
  )
}
