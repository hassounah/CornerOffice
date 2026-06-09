import React from 'react'

interface OverlayBackdropProps {
  onClose: () => void
  children: React.ReactNode
}

/**
 * Semi-transparent backdrop for overlays.
 * Clicking the backdrop area (not the child content) calls onClose.
 */
export function OverlayBackdrop({ onClose, children }: OverlayBackdropProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onClose}
      aria-hidden="false"
    >
      {/* Stop propagation so clicks inside the overlay content don't close it */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative z-50"
      >
        {children}
      </div>
    </div>
  )
}
