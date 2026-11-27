import React from 'react'

/**
 * Animated green dot indicating live/active state.
 * Glows softly. Respects prefers-reduced-motion.
 */
export function PulseDot(): React.ReactElement {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
      <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-co-status-active opacity-40" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-co-status-active shadow-[0_0_6px_color-mix(in_srgb,var(--co-status-active)_50%,transparent)]" />
    </span>
  )
}
