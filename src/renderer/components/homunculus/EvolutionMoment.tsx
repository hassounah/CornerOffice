import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { HomunculusState, EvolvedType } from '@main/types/homunculus'
import { useSettingsStore } from '../../stores/settings-store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvolutionEvent {
  name: string
  type: EvolvedType
  timestamp: string
}

// ---------------------------------------------------------------------------
// Constants (shared with ShipMoment approach)
// ---------------------------------------------------------------------------

const BATCH_WINDOW_MS = 5_000
const DISPLAY_DURATION_MS = 3_000
const MAX_QUEUE_DEPTH = 5

const TYPE_LABEL: Record<EvolvedType, string> = {
  agent: 'agent',
  skill: 'skill',
  command: 'command',
}

// ---------------------------------------------------------------------------
// EvolutionMomentOverlay
// ---------------------------------------------------------------------------

export function EvolutionMomentOverlay(): React.ReactElement | null {
  const shipMomentStyle = useSettingsStore((s) => s.config?.appearance.shipMomentStyle ?? 'full')

  const [{ current }, setMoment] = useState<{ current: EvolutionEvent[] | null; queue: EvolutionEvent[][] }>({ current: null, queue: [] })

  const batchRef = useRef<EvolutionEvent[]>([])
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const displayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track previously known evolved list to detect new entries
  const prevEvolvedRef = useRef<Set<string>>(new Set())

  const flushBatch = useCallback(() => {
    const events = batchRef.current
    batchRef.current = []
    batchTimerRef.current = null
    if (events.length === 0) return
    setMoment((prev) => {
      if (prev.current === null) {
        return { current: events, queue: prev.queue }
      }
      if (prev.queue.length >= MAX_QUEUE_DEPTH) return prev
      return { current: prev.current, queue: [...prev.queue, events] }
    })
  }, [])

  const handleEvolved = useCallback((payload: unknown) => {
    if (shipMomentStyle === 'off') return
    const state = payload as HomunculusState
    if (!state?.evolved) return

    // Find newly evolved entries (not in previous snapshot)
    const newEntries = state.evolved.filter((e) => !prevEvolvedRef.current.has(e.filePath))
    newEntries.forEach((e) => prevEvolvedRef.current.add(e.filePath))

    if (newEntries.length === 0) return

    newEntries.forEach((e) => {
      batchRef.current.push({ name: e.name, type: e.type, timestamp: e.lastModified })
    })

    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushBatch, BATCH_WINDOW_MS)
    }
  }, [shipMomentStyle, flushBatch])

  useEffect(() => {
    if (typeof window.cornerOffice?.on !== 'function') return
    const unsub = window.cornerOffice.on('homunculus:evolved', handleEvolved)
    return () => {
      unsub()
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current)
    }
  }, [handleEvolved])

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

  // Auto-dismiss after display duration, then advance
  useEffect(() => {
    if (!current) return
    if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    displayTimerRef.current = setTimeout(advanceQueue, DISPLAY_DURATION_MS)
    return () => {
      if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    }
  }, [current, advanceQueue])

  if (!current || shipMomentStyle === 'off') return null

  const isMulti = current.length > 1
  const first = current[0]!

  const card = (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={[
        'flex flex-col items-center gap-4 text-center px-6',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300',
      ].join(' ')}
    >
      <span className="text-6xl" aria-hidden="true">✨</span>
      {isMulti ? (
        <>
          <h2 className="text-2xl font-bold text-co-accent">
            {current.length} Artifacts Evolved!
          </h2>
          <ul className="flex flex-col gap-1">
            {current.map((ev, i) => (
              <li key={i} className="text-sm text-co-text-secondary capitalize">
                New {TYPE_LABEL[ev.type]}: <span className="font-medium text-co-text-primary">{ev.name}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <h2 className="text-2xl font-bold text-co-accent">
            New {TYPE_LABEL[first.type]} evolved!
          </h2>
          <p className="text-lg font-medium text-co-text-primary">{first.name}</p>
        </>
      )}
    </div>
  )

  if (shipMomentStyle === 'compact') {
    return (
      <div className="fixed bottom-4 right-4 z-50 w-72" data-testid="evolution-moment-compact">
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl bg-co-bg-elevated/90 border border-co-accent/20 backdrop-blur-md">
          <span className="text-2xl" aria-hidden="true">✨</span>
          <div className="min-w-0">
            {isMulti ? (
              <p className="text-sm font-semibold text-co-accent">{current.length} artifacts evolved!</p>
            ) : (
              <>
                <p className="text-sm font-semibold text-co-accent truncate capitalize">
                  New {TYPE_LABEL[first.type]}: {first.name}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      data-testid="evolution-moment-full"
    >
      {card}
    </div>
  )
}
