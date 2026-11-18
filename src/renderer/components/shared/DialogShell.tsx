import React, { useEffect, useLayoutEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// DialogShell — the native modal <dialog> shell shared by ConfirmDialog and the
// workspace dialogs (0039 step 1.8).
//
// Owns: showModal (top layer), Escape -> onCancel, aria-labelledby/describedby,
// a generic focus trap over every focusable descendant, initial focus, and
// focus return to the opener (or `fallbackFocus` when the opener has unmounted).
//
// Does NOT own chrome: there is deliberately no `skin` prop (UX M-9). Callers
// render their own backdrop, panel and styling as `children`.
//
// Rendered as a native modal <dialog> so it enters the browser top layer; a
// dialog opened from another modal <dialog> stacks above it. Escape is routed
// only to the topmost open shell.
// ---------------------------------------------------------------------------

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([disabled])',
].join(',')

/** An explicit negative tabindex takes an element out of the Tab order. */
function hasNegativeTabindex(el: HTMLElement): boolean {
  const raw = el.getAttribute('tabindex')
  return raw !== null && Number.parseInt(raw, 10) < 0
}

/** Open shells, oldest first. Only the last one reacts to Escape / Tab. */
const openShells: symbol[] = []

export interface DialogShellProps {
  open: boolean
  /** Escape (and any caller-wired dismissal) lands here. */
  onCancel: () => void
  /** id of the element naming the dialog. */
  labelledBy: string
  /** id of the element describing the dialog. */
  describedBy?: string
  /** Element focused when the dialog opens. Required: every dialog picks its safe default. */
  initialFocusRef: React.RefObject<HTMLElement | null>
  /** Receives focus on close when the opener has unmounted (UX M-5). */
  fallbackFocus?: React.RefObject<HTMLElement | null>
  role?: 'dialog' | 'alertdialog'
  className?: string
  children: React.ReactNode
}

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && !hasNegativeTabindex(el),
  )
}

export function DialogShell({
  open,
  onCancel,
  labelledBy,
  describedBy,
  initialFocusRef,
  fallbackFocus,
  role = 'dialog',
  className,
  children,
}: DialogShellProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const onCancelRef = useRef(onCancel)
  const fallbackRef = useRef(fallbackFocus)
  // Set in the layout effect (not a passive one) so two shells mounting in one
  // commit each keep their own id.
  const shellIdRef = useRef<symbol | null>(null)

  useLayoutEffect(() => {
    onCancelRef.current = onCancel
    fallbackRef.current = fallbackFocus
  })

  // Enter the top layer before paint; remember the opener; restore focus on close.
  useLayoutEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    const id = Symbol('dialog-shell')
    shellIdRef.current = id
    openShells.push(id)

    return () => {
      const idx = openShells.indexOf(id)
      if (idx !== -1) openShells.splice(idx, 1)
      // A modal dialog makes the rest of the page inert until it is closed, and React
      // runs this cleanup around the node's removal: close first, or focus() is a no-op.
      // Use the element captured above: React may already have detached `dialogRef`.
      dialog?.close()
      if (opener?.isConnected) {
        opener.focus()
      } else {
        const fallback = fallbackRef.current?.current
        if (fallback?.isConnected) fallback.focus()
      }
    }
  }, [open])

  useEffect(() => {
    if (open) initialFocusRef.current?.focus()
  }, [open, initialFocusRef])

  // Escape -> onCancel, and the Tab trap. Registered per open shell, but only
  // the topmost shell acts.
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (openShells[openShells.length - 1] !== shellIdRef.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancelRef.current()
        return
      }
      if (e.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const items = focusableWithin(dialog)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && dialog.contains(active)
      if (!inside) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open])

  if (!open) return null

  // Native Escape would close the <dialog> behind React's back: block it; the
  // keydown handler above routes Escape to onCancel.
  return (
    <dialog
      ref={dialogRef}
      className={className}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(e) => e.preventDefault()}
    >
      {children}
    </dialog>
  )
}
