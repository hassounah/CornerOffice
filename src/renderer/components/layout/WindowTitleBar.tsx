import React, { useState, useEffect, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Traffic light button — Mac-style colored dot with hover icon
// ---------------------------------------------------------------------------

type TrafficAction = 'close' | 'minimize' | 'maximize'

const TRAFFIC_CONFIG: Record<
  TrafficAction,
  { color: string; hoverBg: string; icon: React.ReactNode }
> = {
  close: {
    color: '#ff5f57',
    hoverBg: '#ff5f57',
    icon: (
      <svg width="8" height="8" viewBox="0 0 8 8" stroke="#4a0002" strokeWidth="1.25" strokeLinecap="round">
        <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
        <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
      </svg>
    ),
  },
  minimize: {
    color: '#febc2e',
    hoverBg: '#febc2e',
    icon: (
      <svg width="8" height="8" viewBox="0 0 8 8" stroke="#995700" strokeWidth="1.25" strokeLinecap="round">
        <line x1="1" y1="4" x2="7" y2="4" />
      </svg>
    ),
  },
  maximize: {
    color: '#28c840',
    hoverBg: '#28c840',
    icon: (
      <svg width="8" height="8" viewBox="0 0 8 8" stroke="#006500" strokeWidth="1.25" strokeLinecap="round">
        <polyline points="1.5,5 1.5,2.5 4,2.5" fill="none" />
        <polyline points="6.5,3 6.5,5.5 4,5.5" fill="none" />
      </svg>
    ),
  },
}

function TrafficDot({
  action,
  groupHovered,
  onClick,
}: {
  action: TrafficAction
  groupHovered: boolean
  onClick: () => void
}): React.ReactElement {
  const cfg = TRAFFIC_CONFIG[action]

  return (
    <button
      onClick={onClick}
      className="relative flex items-center justify-center w-[13px] h-[13px] rounded-full transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
      style={{
        backgroundColor: cfg.color,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
      aria-label={action === 'close' ? 'Close window' : action === 'minimize' ? 'Minimize window' : 'Maximize window'}
    >
      {/* Icon — only visible when group is hovered */}
      <span
        className="flex items-center justify-center transition-opacity duration-100"
        style={{ opacity: groupHovered ? 1 : 0 }}
      >
        {cfg.icon}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// WindowTitleBar — frameless window chrome replacement
// ---------------------------------------------------------------------------

export function WindowTitleBar(): React.ReactElement {
  const [groupHovered, setGroupHovered] = useState(false)
  // Check maximized state on mount and when window resizes
  const checkMaximized = useCallback(async () => {
    try {
      await window.cornerOffice.windowControls.isMaximized()
    } catch {
      // silently ignore — window may not be ready
    }
  }, [])

  useEffect(() => {
    checkMaximized()
    // Re-check on resize (covers maximize/unmaximize)
    const onResize = () => checkMaximized()
    globalThis.addEventListener('resize', onResize)
    return () => globalThis.removeEventListener('resize', onResize)
  }, [checkMaximized])

  const handleMinimize = () => window.cornerOffice.windowControls.minimize()
  const handleMaximize = async () => {
    await window.cornerOffice.windowControls.maximize()
    checkMaximized()
  }
  const handleClose = () => window.cornerOffice.windowControls.close()

  return (
    <div
      className="co-titlebar flex items-center h-10 shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Title with logo — centered absolutely across the full width */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none gap-1.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="10" height="10" rx="2" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="16" y="3" width="5" height="5" rx="1.5" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="16" y="11" width="5" height="10" rx="1.5" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="3" y="16" width="10" height="5" rx="1.5" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[12px] font-medium tracking-wide text-co-text-muted/60">
          Corner Office
        </span>
      </div>

      {/* Traffic light dots — right side */}
      <div
        className="flex items-center gap-[8px] ml-auto pl-4 pr-[18px] h-full"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onMouseEnter={() => setGroupHovered(true)}
        onMouseLeave={() => setGroupHovered(false)}
      >
        <TrafficDot action="minimize" groupHovered={groupHovered} onClick={handleMinimize} />
        <TrafficDot action="maximize" groupHovered={groupHovered} onClick={handleMaximize} />
        <TrafficDot action="close" groupHovered={groupHovered} onClick={handleClose} />
      </div>
    </div>
  )
}
