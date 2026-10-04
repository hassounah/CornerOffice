import React, { useId, useState, useEffect, useCallback } from 'react'

// ---------------------------------------------------------------------------
// DisabledReason — the shared accessible "disabled with a reason" primitive
// (TRD §3.15.1, UX-C2). Built once, used by every disabled-with-reason
// control in the sandbox feature: the chooser's Sandbox option, the Start
// button during `ending`, locked toolchain rows, Hand off/Delete/Recreate,
// the Code Explorer sandbox toggle and Edit/Save gate, and the Build button
// while a build runs.
//
// Render-prop: with a `reason`, the child gets `aria-disabled="true"` (never
// the `disabled` attribute, so it stays focusable and reachable by screen
// readers), `aria-describedby`, and a click handler that only reveals the
// reason (touch has no hover). The description span is always rendered so
// `aria-describedby` never dangles: visually hidden until the reason is
// shown, and a `role="tooltip"` bubble while it is. It shows on hover, on
// keyboard focus and on click; Escape hides it.
//
// `skin="realm"` reuses RealmTooltip's visual style only — RealmTooltip
// itself is pure CSS hover/focus-within with no Escape handling, so the
// show/hide and Escape behaviour is built fresh here for both skins.
// `skin="office"` uses a small Tailwind bubble. The copy is plain text,
// identical in both skins.
//
// Usage: spread `{...props}` onto the child, AFTER any of the child's own
// handlers (e.g. `<button onClick={start} {...props}>`), so the injected
// no-op `onClick` (only present when `reason` is set) takes priority over
// the real handler. When `reason` is null, `props` is `{}` — the child's
// own handlers are untouched.
// ---------------------------------------------------------------------------

export interface DisabledReasonChildProps {
  'aria-disabled'?: 'true'
  'aria-describedby'?: string
  onClick?: (e: React.MouseEvent) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onFocus?: () => void
  onBlur?: () => void
}

export interface DisabledReasonProps {
  reason: string | null
  skin: 'office' | 'realm'
  children: (props: DisabledReasonChildProps) => React.ReactElement
}

// Matches RealmTooltip's inline style exactly (styling only — RealmTooltip
// itself isn't reused as a wrapper; see the module comment).
const REALM_TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgba(30,20,10,0.92)',
  color: '#c9a84c',
  border: '1px solid rgba(201,168,76,0.4)',
  fontFamily: 'serif',
}

const TOOLTIP_BASE_CLASS =
  'absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs w-max max-w-xs whitespace-normal z-50 pointer-events-none'
const REALM_TOOLTIP_CLASS = `${TOOLTIP_BASE_CLASS} rounded`
const OFFICE_TOOLTIP_CLASS = `${TOOLTIP_BASE_CLASS} rounded-md bg-co-bg-tertiary text-co-text-primary border border-co-border shadow-lg`

export function DisabledReason({ reason, skin, children }: DisabledReasonProps): React.ReactElement {
  const tooltipId = useId()
  const [visible, setVisible] = useState(false)

  const show = useCallback(() => setVisible(true), [])
  const hide = useCallback(() => setVisible(false), [])

  // Escape hides the tooltip — for both skins, since RealmTooltip's own CSS
  // hover/focus-within has no keyboard-dismiss behaviour to inherit.
  useEffect(() => {
    if (!reason || !visible) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [reason, visible, hide])

  // The wrapper is the same element with or without a reason, so the child keeps
  // its identity (and focus) when the reason toggles, e.g. when `ending` clears.
  // `visible` may still be true from a previous, now-cleared reason, but the
  // tooltip is only rendered while a reason is set.
  const childProps: DisabledReasonChildProps = reason ? {
    'aria-disabled': 'true',
    'aria-describedby': tooltipId,
    onClick: (e) => {
      e.preventDefault()
      show()
    },
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  } : {}

  return (
    <span className="relative inline-block">
      {children(childProps)}
      {!reason ? null : visible ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={skin === 'realm' ? REALM_TOOLTIP_CLASS : OFFICE_TOOLTIP_CLASS}
          style={skin === 'realm' ? REALM_TOOLTIP_STYLE : undefined}
        >
          {reason}
        </span>
      ) : (
        <span id={tooltipId} className="sr-only">
          {reason}
        </span>
      )}
    </span>
  )
}
