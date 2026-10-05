import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../stores/settings-store'

// ---------------------------------------------------------------------------
// Code Explorer tree/viewer split (TRD #0031 §3.2). The tree keeps a px width
// (IDE style): the stored value is only written by a drag, a key press or a
// reset, and is clamped at render time, so shrinking the window never
// overwrites the user's choice.
// ---------------------------------------------------------------------------

export const TREE_MIN_PX = 180
export const VIEWER_MIN_PX = 360
export const TREE_DEFAULT_PX = 288
export const DIVIDER_PX = 4
export const KEY_STEP_PX = 16
export const PERSIST_DEBOUNCE_MS = 300

/** containerWidth <= 0 means "unknown" (first paint / jsdom): only TREE_MIN applies. */
export function maxTreeWidth(containerWidth: number): number {
  if (containerWidth <= 0) return Infinity
  return Math.max(TREE_MIN_PX, containerWidth - VIEWER_MIN_PX - DIVIDER_PX)
}

export function clampTreeWidth(px: number, containerWidth: number): number {
  return Math.min(Math.max(px, TREE_MIN_PX), maxTreeWidth(containerWidth))
}

export interface ExplorerSplit {
  /** Clamped width, what is rendered. */
  treeWidth: number
  /** Bounds for aria and keyboard Home/End. */
  min: number
  max: number
  /** Measured container width, 0 until the first ResizeObserver callback. */
  containerWidth: number
  dragging: boolean
  beginDrag(e: React.PointerEvent<HTMLElement>): void
  onKeyDown(e: React.KeyboardEvent<HTMLElement>): void
  reset(): void
}

/**
 * `containerRef` is owned by the caller (attached to the row that holds the tree,
 * divider and viewer) so the returned object never carries a ref and can be
 * passed through render.
 */
export function useExplorerSplit(containerRef: React.RefObject<HTMLDivElement | null>): ExplorerSplit {
  const persisted = useSettingsStore((s) => s.config?.codeExplorer?.treeWidth)
  const [local, setLocal] = useState<number | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [dragging, setDragging] = useState(false)

  const raw = local ?? persisted ?? TREE_DEFAULT_PX
  const treeWidth = clampTreeWidth(raw, containerWidth)
  const max = maxTreeWidth(containerWidth)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<number | null>(null)
  const widthRef = useRef(treeWidth)
  const containerWidthRef = useRef(containerWidth)
  useEffect(() => {
    widthRef.current = treeWidth
    containerWidthRef.current = containerWidth
  }, [treeWidth, containerWidth])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef])

  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const width = pendingRef.current
    if (width === null) return
    pendingRef.current = null
    useSettingsStore
      .getState()
      .updateConfig({ codeExplorer: { treeWidth: Math.round(width) } })
      .catch((err: unknown) => {
        console.warn('[useExplorerSplit] Failed to persist tree width:', err)
      })
  }, [])

  const schedulePersist = useCallback(
    (width: number): void => {
      pendingRef.current = width
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, PERSIST_DEBOUNCE_MS)
    },
    [flush]
  )

  // Flush a pending write on unmount.
  useEffect(() => flush, [flush])

  const commit = useCallback(
    (width: number): void => {
      setLocal(width)
      schedulePersist(width)
    },
    [schedulePersist]
  )

  const beginDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>): void => {
      if (e.button !== 0) return
      e.preventDefault()
      const target = e.currentTarget
      const startX = e.clientX
      const startWidth = widthRef.current
      const pointerId = e.pointerId
      let latest = startWidth
      // A click or double-click with no movement must not persist: startWidth is the clamped,
      // rendered width, and writing it would overwrite the stored choice after a window shrink.
      let moved = false
      target.setPointerCapture(pointerId)
      setDragging(true)

      const onMove = (ev: PointerEvent): void => {
        if (ev.clientX === startX && !moved) return
        moved = true
        latest = clampTreeWidth(startWidth + ev.clientX - startX, containerWidthRef.current)
        setLocal(latest)
      }
      const onEnd = (): void => {
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onEnd)
        target.removeEventListener('pointercancel', onEnd)
        target.releasePointerCapture(pointerId)
        setDragging(false)
        if (moved) schedulePersist(latest)
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onEnd)
      target.addEventListener('pointercancel', onEnd)
    },
    [schedulePersist]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>): void => {
      const cw = containerWidthRef.current
      let next: number
      switch (e.key) {
        case 'ArrowLeft':
          next = widthRef.current - KEY_STEP_PX
          break
        case 'ArrowRight':
          next = widthRef.current + KEY_STEP_PX
          break
        case 'Home':
          next = TREE_MIN_PX
          break
        case 'End':
          next = maxTreeWidth(cw)
          break
        default:
          return
      }
      e.preventDefault()
      // End with an unknown container has no finite max: keep the current width.
      commit(Number.isFinite(next) ? clampTreeWidth(next, cw) : widthRef.current)
    },
    [commit]
  )

  const reset = useCallback((): void => commit(TREE_DEFAULT_PX), [commit])

  return {
    treeWidth,
    min: TREE_MIN_PX,
    max,
    containerWidth,
    dragging,
    beginDrag,
    onKeyDown,
    reset
  }
}
