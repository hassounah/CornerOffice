import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useTerminalStore } from '../../stores/terminal-store'
import { TerminalPanel } from './TerminalPanel'
import type { TerminalPanelHandle } from './TerminalPanel'
import { ShimmerOverlay } from './ShimmerOverlay'
import { unwrapIpc } from '../../utils/ipc'
import type { TerminalWindowBounds } from '@main/types/config'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BOUNDS: TerminalWindowBounds = { x: 10, y: 10, width: 80, height: 80 }
const MIN_WIDTH_PX = 800
const MIN_HEIGHT_PX = 600
/** Height of the header bar — used for off-screen clamping */
const HEADER_HEIGHT_PX = 41
const RESIZE_HANDLE_PX = 8
const SEARCH_DEBOUNCE_MS = 150

type ResizeEdge =
  | 'n' | 's' | 'e' | 'w'
  | 'nw' | 'ne' | 'sw' | 'se'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TerminalOverlayProps {
  workspaceSlug: string
  workspaceName: string
  label?: string
  fontSize?: number
  windowBounds?: TerminalWindowBounds
  onBoundsChange?: (bounds: TerminalWindowBounds) => void
  onHide: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pxToPercent(px: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (px / total) * 100))
}

function clampBounds(
  bounds: TerminalWindowBounds,
  parentW: number,
  parentH: number,
): TerminalWindowBounds {
  if (parentW <= 0 || parentH <= 0) return bounds

  const minWidthPct = pxToPercent(MIN_WIDTH_PX, parentW)
  const minHeightPct = pxToPercent(MIN_HEIGHT_PX, parentH)

  const width = Math.max(bounds.width, minWidthPct)
  const height = Math.max(bounds.height, minHeightPct)

  // maxX: ensure at least MIN_WIDTH_PX / 4 (~200px) of the terminal remains visible horizontally
  // maxY: ensure the full header bar height remains visible vertically
  const maxX = 100 - pxToPercent(Math.min(MIN_WIDTH_PX / 4, parentW * 0.1), parentW)
  const maxY = 100 - pxToPercent(HEADER_HEIGHT_PX, parentH)

  const x = Math.max(0, Math.min(bounds.x, maxX))
  const y = Math.max(0, Math.min(bounds.y, maxY))

  return { x, y, width, height }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalOverlay({
  workspaceSlug,
  workspaceName,
  label,
  fontSize,
  windowBounds,
  onBoundsChange,
  onHide,
}: TerminalOverlayProps): React.ReactElement {
  const sessionState = useTerminalStore((s) => s.sessions[workspaceSlug] ?? 'none')
  const { kill } = useTerminalStore()
  const [shimmerVisible, setShimmerVisible] = useState(true)

  // Two-tap End Session confirmation
  const [isConfirming, setIsConfirming] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Imperative handle ref for search and context menu actions
  const terminalRef = useRef<TerminalPanelHandle | null>(null)

  // Container ref for capture-phase keyboard listener
  const overlayContainerRef = useRef<HTMLDivElement | null>(null)

  // Search state
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchNoResults, setSearchNoResults] = useState(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Parent container ref — for percent↔pixel conversion
  const parentRef = useRef<HTMLDivElement | null>(null)

  // The floating container ref
  const floatingRef = useRef<HTMLDivElement | null>(null)

  // ── Bounds state ──────────────────────────────────────────────────────────

  const [bounds, setBounds] = useState<TerminalWindowBounds>(() =>
    windowBounds ?? DEFAULT_BOUNDS
  )
  // Ref mirror of bounds — used in mousemove handler to avoid stale closure + effect re-registration
  const boundsRef = useRef(bounds)
  useEffect(() => { boundsRef.current = bounds }, [bounds])

  const prevWindowBoundsRef = useRef(windowBounds)
  useEffect(() => {
    if (windowBounds && windowBounds !== prevWindowBoundsRef.current) {
      prevWindowBoundsRef.current = windowBounds
      setBounds(windowBounds)
    }
  }, [windowBounds])

  // ── Drag/resize state ─────────────────────────────────────────────────────

  const isDraggingRef = useRef(false)
  const isResizingRef = useRef(false)
  const resizeEdgeRef = useRef<ResizeEdge | null>(null)
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, x: 0, y: 0, w: 0, h: 0 })
  const [isInteracting, setIsInteracting] = useState(false)

  // ── Parent size tracking ──────────────────────────────────────────────────

  const getParentSize = useCallback((): { w: number; h: number } => {
    const el = parentRef.current
    if (!el) return { w: 0, h: 0 }
    return { w: el.clientWidth, h: el.clientHeight }
  }, [])

  const clampCurrentBounds = useCallback(() => {
    const { w, h } = getParentSize()
    if (w <= 0 || h <= 0) return
    setBounds((prev) => clampBounds(prev, w, h))
  }, [getParentSize])

  useEffect(() => {
    clampCurrentBounds()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const parent = parentRef.current
    if (!parent) return
    const ro = new ResizeObserver(() => clampCurrentBounds())
    ro.observe(parent)

    const onWindowResize = (): void => clampCurrentBounds()
    window.addEventListener('resize', onWindowResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [clampCurrentBounds])

  // ── Search: native capture-phase Ctrl+F / Escape ──────────────────────────
  // Must use native addEventListener with { capture: true } — xterm's canvas
  // uses its own native listener and React's bubble-phase fires too late.

  useEffect(() => {
    const container = overlayContainerRef.current
    if (!container) return

    function handleKeyDown(event: KeyboardEvent): void {
      const isCtrlF = (event.ctrlKey || event.metaKey) && event.key === 'f'

      if (isCtrlF) {
        event.stopPropagation()
        event.preventDefault()
        setSearchVisible(true)
        return
      }

      if (event.key === 'Escape' && searchVisible) {
        event.stopPropagation()
        event.preventDefault()
        if (searchQuery !== '') {
          // Stage 1: clear query but keep bar open
          setSearchQuery('')
          setSearchNoResults(false)
          terminalRef.current?.clearSearch()
        } else {
          // Stage 2: close bar
          setSearchVisible(false)
          setSearchNoResults(false)
          terminalRef.current?.clearSearch()
          terminalRef.current?.focus()
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => container.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [searchVisible, searchQuery])

  // Auto-focus search input when search bar opens
  useEffect(() => {
    if (searchVisible && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [searchVisible])

  // ── Search: debounced input handler ───────────────────────────────────────

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const q = e.target.value
    setSearchQuery(q)
    setSearchNoResults(false)

    if (searchDebounceRef.current !== null) {
      clearTimeout(searchDebounceRef.current)
    }

    if (!q) {
      terminalRef.current?.clearSearch()
      return
    }

    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null
      const found = terminalRef.current?.search(q) ?? true
      setSearchNoResults(!found)
    }, SEARCH_DEBOUNCE_MS)
  }

  function handleSearchInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        const found = terminalRef.current?.searchPrevious(searchQuery) ?? true
        setSearchNoResults(!found)
      } else {
        const found = terminalRef.current?.searchNext(searchQuery) ?? true
        setSearchNoResults(!found)
      }
    }
  }

  function closeSearch(): void {
    setSearchVisible(false)
    setSearchQuery('')
    setSearchNoResults(false)
    terminalRef.current?.clearSearch()
    terminalRef.current?.focus()
  }

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current !== null) clearTimeout(searchDebounceRef.current)
    }
  }, [])

  // ── Drag ──────────────────────────────────────────────────────────────────

  function handleGripMouseDown(e: React.MouseEvent): void {
    e.preventDefault()
    const { w, h } = getParentSize()
    if (w <= 0 || h <= 0) return

    isDraggingRef.current = true
    setIsInteracting(true)

    const pxX = (bounds.x / 100) * w
    const pxY = (bounds.y / 100) * h
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, x: pxX, y: pxY, w: 0, h: 0 }
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  function handleResizeMouseDown(e: React.MouseEvent, edge: ResizeEdge): void {
    e.preventDefault()
    e.stopPropagation()
    const { w, h } = getParentSize()
    if (w <= 0 || h <= 0) return

    isResizingRef.current = true
    resizeEdgeRef.current = edge
    setIsInteracting(true)

    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      x: (bounds.x / 100) * w,
      y: (bounds.y / 100) * h,
      w: (bounds.width / 100) * w,
      h: (bounds.height / 100) * h,
    }
  }

  // ── Global mouse listeners ────────────────────────────────────────────────

  useEffect(() => {
    function onMouseMove(e: MouseEvent): void {
      const { w, h } = getParentSize()
      if (w <= 0 || h <= 0) return

      const dx = e.clientX - dragStartRef.current.mouseX
      const dy = e.clientY - dragStartRef.current.mouseY

      if (isDraggingRef.current) {
        const newPxX = dragStartRef.current.x + dx
        const newPxY = dragStartRef.current.y + dy
        const newBounds: TerminalWindowBounds = {
          ...boundsRef.current,
          x: pxToPercent(newPxX, w),
          y: pxToPercent(newPxY, h),
        }
        setBounds(clampBounds(newBounds, w, h))
      } else if (isResizingRef.current && resizeEdgeRef.current) {
        const edge = resizeEdgeRef.current
        const { x: startX, y: startY, w: startW, h: startH } = dragStartRef.current
        const minWidthPx = MIN_WIDTH_PX
        const minHeightPx = MIN_HEIGHT_PX

        let newX = startX
        let newY = startY
        let newW = startW
        let newH = startH

        if (edge.includes('e')) {
          newW = Math.max(minWidthPx, startW + dx)
        } else if (edge.includes('w')) {
          const proposedW = Math.max(minWidthPx, startW - dx)
          newX = startX + (startW - proposedW)
          newW = proposedW
        }
        if (edge.includes('s')) {
          newH = Math.max(minHeightPx, startH + dy)
        } else if (edge.includes('n')) {
          const proposedH = Math.max(minHeightPx, startH - dy)
          newY = startY + (startH - proposedH)
          newH = proposedH
        }

        const newBounds: TerminalWindowBounds = {
          x: pxToPercent(newX, w),
          y: pxToPercent(newY, h),
          width: pxToPercent(newW, w),
          height: pxToPercent(newH, h),
        }
        setBounds(clampBounds(newBounds, w, h))
      }
    }

    function onMouseUp(): void {
      if (!isDraggingRef.current && !isResizingRef.current) return

      isDraggingRef.current = false
      isResizingRef.current = false
      resizeEdgeRef.current = null
      setIsInteracting(false)

      setBounds((current) => {
        onBoundsChange?.(current)
        return current
      })
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [getParentSize, onBoundsChange])

  // ── Confirmation timer cleanup ────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  function handleEndSession(): void {
    if (isConfirming) {
      if (confirmTimerRef.current !== null) {
        clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = null
      }
      setIsConfirming(false)
      void kill(workspaceSlug)
    } else {
      setIsConfirming(true)
      confirmTimerRef.current = setTimeout(() => {
        confirmTimerRef.current = null
        setIsConfirming(false)
      }, 3_000)
    }
  }

  const isStopping = sessionState === 'stopping'

  // ── Context menu ──────────────────────────────────────────────────────────

  async function handleContextMenu(e: React.MouseEvent): Promise<void> {
    e.preventDefault()
    const hasSelection = terminalRef.current?.hasSelection() ?? false
    // Read selection BEFORE the async IPC roundtrip — selection may be cleared while menu is open
    const selectionText = hasSelection ? (terminalRef.current?.getSelection() ?? '') : ''
    try {
      const response = await window.cornerOffice.terminal.showContextMenu(hasSelection, workspaceSlug)
      const result = unwrapIpc(response)
      if (!result.action) return
      switch (result.action) {
        case 'copy': {
          if (selectionText) {
            void navigator.clipboard.writeText(selectionText)
          }
          break
        }
        case 'paste': {
          if (result.text != null) {
            terminalRef.current?.writeText(result.text)
          }
          break
        }
        case 'selectAll':
          terminalRef.current?.selectAll()
          break
        case 'clear':
          terminalRef.current?.clearTerminal()
          break
        case 'search':
          setSearchVisible(true)
          break
      }
    } catch {
      // IPC error — ignore, menu already closed
    }
  }

  // ── Computed floating style ───────────────────────────────────────────────

  const floatingStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${bounds.x}%`,
    top: `${bounds.y}%`,
    width: `${bounds.width}%`,
    height: `${bounds.height}%`,
    minWidth: MIN_WIDTH_PX,
    minHeight: MIN_HEIGHT_PX,
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#18181b',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    borderRadius: '6px',
    overflow: 'hidden',
    contain: 'layout',
  }

  // ── Resize handle style factory ───────────────────────────────────────────

  function resizeHandleStyle(edge: ResizeEdge): React.CSSProperties {
    const cursors: Record<ResizeEdge, string> = {
      n: 'ns-resize', s: 'ns-resize',
      e: 'ew-resize', w: 'ew-resize',
      nw: 'nw-resize', ne: 'ne-resize',
      sw: 'sw-resize', se: 'se-resize',
    }
    const base: React.CSSProperties = {
      position: 'absolute',
      zIndex: 10,
      cursor: cursors[edge],
    }
    const H = RESIZE_HANDLE_PX
    if (edge === 'n')  return { ...base, top: 0, left: H, right: H, height: H }
    if (edge === 's')  return { ...base, bottom: 0, left: H, right: H, height: H }
    if (edge === 'e')  return { ...base, top: H, bottom: H, right: 0, width: H }
    if (edge === 'w')  return { ...base, top: H, bottom: H, left: 0, width: H }
    if (edge === 'nw') return { ...base, top: 0, left: 0, width: H, height: H }
    if (edge === 'ne') return { ...base, top: 0, right: 0, width: H, height: H }
    if (edge === 'sw') return { ...base, bottom: 0, left: 0, width: H, height: H }
    return { ...base, bottom: 0, right: 0, width: H, height: H } // se
  }

  const EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']

  return (
    <div
      ref={parentRef}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 100 }}
    >
      {/* Pointer-events blocker during drag/resize */}
      {isInteracting && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'all' }} />
      )}

      {/* Floating terminal window */}
      <div
        ref={(el) => {
          floatingRef.current = el
          overlayContainerRef.current = el
        }}
        style={{ ...floatingStyle, pointerEvents: 'all' }}
      >
        {/* Resize handles */}
        {EDGES.map((edge) => (
          <div
            key={edge}
            style={resizeHandleStyle(edge)}
            onMouseDown={(e) => handleResizeMouseDown(e, edge)}
            onMouseOver={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.12)'
            }}
            onMouseOut={(e) => {
              ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
            }}
          />
        ))}

        {/* Header */}
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid #27272a',
            userSelect: 'none',
          }}
        >
          {/* Drag grip zone */}
          <div
            onMouseDown={handleGripMouseDown}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              cursor: isInteracting && isDraggingRef.current ? 'grabbing' : 'grab',
              flex: 1,
              minWidth: 0,
              padding: '2px 4px',
              borderRadius: '4px',
            }}
          >
            <svg
              width="12"
              height="16"
              viewBox="0 0 12 16"
              fill="none"
              style={{ flexShrink: 0, opacity: 0.4 }}
            >
              <circle cx="3" cy="4" r="1.5" fill="#a1a1aa" />
              <circle cx="9" cy="4" r="1.5" fill="#a1a1aa" />
              <circle cx="3" cy="8" r="1.5" fill="#a1a1aa" />
              <circle cx="9" cy="8" r="1.5" fill="#a1a1aa" />
              <circle cx="3" cy="12" r="1.5" fill="#a1a1aa" />
              <circle cx="9" cy="12" r="1.5" fill="#a1a1aa" />
            </svg>
            <span
              style={{
                color: '#a1a1aa',
                fontSize: '13px',
                fontFamily: 'Menlo, Consolas, "Courier New", monospace',
                letterSpacing: '0.02em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {label ?? workspaceName}
            </span>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button
              onClick={handleEndSession}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={isStopping}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                borderRadius: '4px',
                border: 'none',
                cursor: isStopping ? 'not-allowed' : 'pointer',
                backgroundColor: isConfirming ? 'rgba(245,158,11,0.15)' : '#27272a',
                color: isConfirming ? '#f59e0b' : '#e4e4e7',
                opacity: isStopping ? 0.5 : 1,
                transition: 'background-color 0.15s, color 0.15s',
              }}
            >
              {isStopping ? 'Ending...' : isConfirming ? 'Confirm End?' : 'End Session'}
            </button>

            <button
              onClick={onHide}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: '#27272a',
                color: '#a1a1aa',
              }}
            >
              Hide
            </button>
          </div>
        </div>

        {/* Search bar — between header and terminal */}
        {searchVisible && (
          <div
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 10px',
              backgroundColor: '#27272a',
              borderBottom: '1px solid #3f3f46',
            }}
          >
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              onKeyDown={handleSearchInputKeyDown}
              placeholder="Search…"
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: '13px',
                fontFamily: 'Menlo, Consolas, "Courier New", monospace',
                backgroundColor: '#18181b',
                color: '#e4e4e7',
                border: `1px solid ${searchNoResults ? '#ef4444' : '#3f3f46'}`,
                borderRadius: '4px',
                outline: 'none',
                transition: 'border-color 0.1s',
              }}
              aria-label="Search terminal"
            />
            <button
              onClick={() => {
                const found = terminalRef.current?.searchPrevious(searchQuery) ?? true
                setSearchNoResults(!found)
              }}
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: '#3f3f46',
                color: '#e4e4e7',
                minWidth: '32px',
                minHeight: '28px',
              }}
            >
              Prev
            </button>
            <button
              onClick={() => {
                const found = terminalRef.current?.searchNext(searchQuery) ?? true
                setSearchNoResults(!found)
              }}
              title="Next match (Enter)"
              aria-label="Next match"
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: '#3f3f46',
                color: '#e4e4e7',
                minWidth: '32px',
                minHeight: '28px',
              }}
            >
              Next
            </button>
            <button
              onClick={closeSearch}
              title="Close search (Escape)"
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: 'transparent',
                color: '#71717a',
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Terminal area */}
        <div
          style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
          onContextMenu={(e) => void handleContextMenu(e)}
        >
          <TerminalPanel
            ref={terminalRef}
            workspaceSlug={workspaceSlug}
            fontSize={fontSize}
            onReady={() => setShimmerVisible(false)}
          />
          <ShimmerOverlay
            visible={shimmerVisible}
            workspaceSlug={workspaceSlug}
            sessionState={sessionState}
          />
        </div>
      </div>
    </div>
  )
}
