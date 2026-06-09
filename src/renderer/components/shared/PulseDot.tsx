import React from 'react'

/**
 * Animated green dot indicating live/active state.
 * Glows softly. Respects prefers-reduced-motion.
 */
export function PulseDot(): React.ReactElement {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
      <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-40" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
    </span>
  )
}
