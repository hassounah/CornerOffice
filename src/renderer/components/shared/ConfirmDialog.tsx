import React, { useId, useRef } from 'react'
import { DialogShell } from './DialogShell'

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

const REALM_ERROR: React.CSSProperties = {
  fontSize: 13,
  color: '#e07a5f',
  marginBottom: 16,
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
  /** Extra content between the message and the buttons (e.g. a list of affected items). */
  details?: React.ReactNode
  /** Failure text shown above the buttons, announced as an alert. */
  error?: string
  /**
   * Receives focus on close when the element that opened the dialog has unmounted (UX M-5): confirming a removal
   * deletes the row the Remove button lived in, and focus would otherwise fall to the page.
   */
  fallbackFocus?: React.RefObject<HTMLElement | null>
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
//
// Rendered as a native modal <dialog> (showModal) so it enters the browser top
// layer. The Office DocViewerOverlay is itself a modal <dialog>: anything
// outside the top layer paints BENEATH it no matter its z-index, and is inert
// (unclickable) while it is open. Top-layer elements stack in open order, so a
// confirm opened from the viewer always lands above it.
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
  details,
  error,
  fallbackFocus,
}: ConfirmDialogProps): React.ReactElement | null {
  const uid = useId()
  const titleId = `${uid}-title`
  const messageId = `${uid}-message`
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // The modal <dialog>, Escape -> onCancel (never onConfirm), the focus trap and
  // initial focus on CANCEL (safe default per §17 R17) all live in DialogShell.
  const renderShell = (children: React.ReactNode): React.ReactElement => (
    <DialogShell
      open={open}
      onCancel={onCancel}
      labelledBy={titleId}
      describedBy={messageId}
      initialFocusRef={cancelRef}
      fallbackFocus={fallbackFocus}
      role="alertdialog"
      className="co-confirm-dialog"
    >
      {children}
    </DialogShell>
  )

  const errorBlock = error ? (
    <p
      role="alert"
      className={skin === 'realm' ? undefined : 'text-sm text-co-status-attention mb-4'}
      style={skin === 'realm' ? REALM_ERROR : undefined}
    >
      {error}
    </p>
  ) : null

  if (!open) return null

  if (skin === 'realm') {
    return renderShell(
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Backdrop */}
        <div
          style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }}
          onClick={onCancel}
        />
        {/* Panel */}
        <div ref={containerRef} style={REALM_OVERLAY}>
          <div id={titleId} style={REALM_TITLE}>{title}</div>
          <div id={messageId} style={REALM_MESSAGE}>{message}</div>
          {details}
          {errorBlock}
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
  return renderShell(
    <div className="fixed inset-0 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      {/* Panel */}
      <div
        ref={containerRef}
        className="relative bg-co-bg-primary border border-co-border rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4"
      >
        <h2
          id={titleId}
          className="text-sm font-semibold text-co-text-primary mb-2"
        >
          {title}
        </h2>
        <p
          id={messageId}
          className="text-sm text-co-text-secondary mb-6 leading-relaxed"
        >
          {message}
        </p>
        {details}
        {errorBlock}
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
