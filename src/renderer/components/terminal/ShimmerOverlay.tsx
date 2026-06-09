import React from 'react'
import type { TerminalSessionState } from '../../stores/terminal-store'

export type { TerminalSessionState }

interface ShimmerOverlayProps {
  visible: boolean
  workspaceSlug: string
  sessionState: TerminalSessionState
}

/** Deterministic pseudo-random number in [0, 1) from a string seed + index. */
function seededRandom(seed: string, index: number): number {
  let hash = index * 2654435761
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i) * (i + 1) * 1000003
    hash = (hash << 5) - hash
    hash >>>= 0
  }
  return (hash >>> 0) / 0xffffffff
}

const LINE_COUNT = 8
const MIN_WIDTH = 0.35
const MAX_WIDTH = 0.92

function getLineWidths(slug: string): number[] {
  return Array.from({ length: LINE_COUNT }, (_, i) =>
    MIN_WIDTH + seededRandom(slug, i) * (MAX_WIDTH - MIN_WIDTH)
  )
}

function getLabel(sessionState: TerminalSessionState): string {
  if (sessionState === 'starting') return 'Starting session...'
  return 'Restoring terminal...'
}

export function ShimmerOverlay({ visible, workspaceSlug, sessionState }: ShimmerOverlayProps): React.ReactElement {
  const lineWidths = getLineWidths(workspaceSlug)
  const gradientId = `shimmer-${workspaceSlug}`

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        backgroundColor: '#18181b',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.3s ease',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px',
        gap: '12px',
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#27272a" />
            <stop offset="50%" stopColor="#52525b" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#27272a" />
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              values="-1 0; 1 0; -1 0"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </linearGradient>
        </defs>
        {lineWidths.map((w, i) => (
          <rect
            key={i}
            x="16"
            y={16 + i * 28}
            width={`calc(${(w * 100).toFixed(1)}% - 32px)`}
            height="12"
            rx="4"
            fill={`url(#${gradientId})`}
          />
        ))}
      </svg>

      <div
        style={{
          position: 'absolute',
          bottom: '24px',
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          color: '#71717a',
          fontSize: '13px',
          fontFamily: 'Menlo, Consolas, "Courier New", monospace',
          letterSpacing: '0.02em',
        }}
      >
        {getLabel(sessionState)}
      </div>
    </div>
  )
}
