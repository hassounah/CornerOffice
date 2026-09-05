import React, { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Realm skin style constants (matches RealmDocViewer inline style palette)
// ---------------------------------------------------------------------------

const REALM_OVERLAY: React.CSSProperties = {
  // position:relative + zIndex keep the panel ABOVE the absolutely-positioned
  // backdrop. Without this the static panel paints below the backdrop, which then
  // swallows all clicks (firing onCancel) and dims the panel. (Office uses `relative`.)
  position: 'relative',
  zIndex: 1,
  background: 'rgba(10,6,2,0.85)',
  border: '1px solid #c9a84c',
  borderRadius: 4,
  fontFamily: 'serif',
  color: '#e8dcc8',
  padding: '24px 28px',
  minWidth: 320,
  maxWidth: 480,
  boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
}

const REALM_TITLE: React.CSSProperties = {
  fontSize: 14,
  color: '#c9a84c',
  textTransform: 'uppercase',
  letterSpacing: 1,
  marginBottom: 10,
  fontFamily: 'serif',
}

const REALM_MESSAGE: React.CSSProperties = {
  fontSize: 14,
  color: '#e8dcc8',
  marginBottom: 20,
  lineHeight: 1.5,
}

const REALM_BUTTON_ROW: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
}

const REALM_BUTTON_CANCEL: React.CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  background: 'transparent',
  border: '1px solid #c9a84c',
  color: '#c9a84c',
  borderRadius: 3,
  cursor: 'pointer',
  fontFamily: 'serif',
}

const REALM_BUTTON_CONFIRM: React.CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  background: 'rgba(201,168,76,0.15)',
  border: '1px solid #c9a84c',
  color: '#c9a84c',
  borderRadius: 3,
  cursor: 'pointer',
  fontFamily: 'serif',
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  skin?: 'office' | 'realm'
}

// ---------------------------------------------------------------------------
// ConfirmDialog
//
// §17 R17 accessibility requirements:
//   - role="alertdialog"
//   - Initial focus on the CANCEL button (safe default)
//   - Focus trap while open
//   - Escape fires onCancel (never onConfirm)
// §17 R11: rendered by a single host high in the tree; does not manage its own
//          portal — the host is responsible for placement.
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  skin = 'office',
}: ConfirmDialogProps): React.ReactElement | null {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus the cancel button when the dialog opens (safe default per §17 R17)
  useEffect(() => {
    if (open) {
      cancelRef.current?.focus()
    }
  }, [open])

  // Escape key fires onCancel (§17 R17 — never onConfirm)
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }

      // Focus trap: keep Tab/Shift+Tab within the two buttons
      if (e.key === 'Tab') {
        const cancel = cancelRef.current
        const confirm = confirmRef.current
        if (!cancel || !confirm) return

        if (e.shiftKey) {
          if (document.activeElement === cancel) {
            e.preventDefault()
            confirm.focus()
          }
        } else {
          if (document.activeElement === confirm) {
            e.preventDefault()
            cancel.focus()
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open, onCancel])

  if (!open) return null

  if (skin === 'realm') {
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
        }}
      >
        {/* Backdrop */}
        <div
          style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }}
          onClick={onCancel}
        />
        {/* Panel */}
        <div ref={containerRef} style={REALM_OVERLAY}>
          <div id="confirm-dialog-title" style={REALM_TITLE}>{title}</div>
          <div id="confirm-dialog-message" style={REALM_MESSAGE}>{message}</div>
          <div style={REALM_BUTTON_ROW}>
            <button ref={cancelRef} style={REALM_BUTTON_CANCEL} onClick={onCancel}>
              {cancelLabel}
            </button>
            <button ref={confirmRef} style={REALM_BUTTON_CONFIRM} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Office skin — co-* Tailwind classes matching DocViewerOverlay
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      className="fixed inset-0 flex items-center justify-center z-[9999]"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      {/* Panel */}
      <div
        ref={containerRef}
        className="relative bg-co-bg-primary border border-co-border rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4"
      >
        <h2
          id="confirm-dialog-title"
          className="text-sm font-semibold text-co-text-primary mb-2"
        >
          {title}
        </h2>
        <p
          id="confirm-dialog-message"
          className="text-sm text-co-text-secondary mb-6 leading-relaxed"
        >
          {message}
        </p>
        <div className="flex gap-2 justify-end">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 text-sm text-co-text-secondary hover:text-co-text-primary bg-co-bg-tertiary hover:bg-co-bg-tertiary/80 rounded-lg transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent hover:bg-co-accent/20 rounded-lg transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
