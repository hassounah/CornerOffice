import React, { useState } from 'react'

// ---------------------------------------------------------------------------
// Explorer toolbar primitives (#0036). Pure presentation: every state rule
// (hover / active / focus / disabled / pressed / reduced motion) lives in the
// `.co-tb*` block of globals.css, keyed on `data-skin`, so each primitive
// works standalone in both skins. The remaining props are spread onto the
// <button>, so the caller keeps owning aria-*, title, tabIndex and handlers.
// ---------------------------------------------------------------------------

type Skin = 'office' | 'realm'

export type ToolbarButtonVariant = 'ghost' | 'icon' | 'pill' | 'search' | 'segment'

export interface ToolbarButtonProps extends React.ComponentProps<'button'> {
  skin: Skin
  variant: ToolbarButtonVariant
  /** A user-initiated request tied to this control is in flight. */
  busy?: boolean
  tone?: 'warning'
}

export function ToolbarButton({ skin, variant, busy, tone, className, onClick, ...button }: ToolbarButtonProps): React.ReactElement {
  // aria-disabled keeps the control focusable (its tooltip reason stays reachable), so the
  // primitive itself swallows the click: a disabled-looking control can never act.
  const disabled = button['aria-disabled'] === true || button['aria-disabled'] === 'true'
  return (
    <button
      type="button"
      {...button}
      onClick={disabled ? undefined : onClick}
      className={className ? `co-tb co-tb-btn ${className}` : 'co-tb co-tb-btn'}
      data-skin={skin}
      data-variant={variant}
      data-tone={tone}
      aria-busy={busy || undefined}
    />
  )
}

export interface SegmentedControlProps {
  skin: Skin
  'aria-label'?: string
  'aria-labelledby'?: string
  children: React.ReactNode
}

export function SegmentedControl({ skin, children, ...labelling }: SegmentedControlProps): React.ReactElement {
  return (
    <div role="group" className="co-tb co-tb-seg" data-skin={skin} {...labelling}>
      {children}
    </div>
  )
}

export interface FilterChipProps extends Omit<ToolbarButtonProps, 'variant' | 'busy' | 'tone' | 'aria-pressed'> {
  pressed: boolean
  count?: number
}

export function FilterChip({ pressed, count, children, ...button }: FilterChipProps): React.ReactElement {
  // Previous-value-in-state: remounting the badge (via key) restarts its one-shot flash
  // without an effect or a timer. The first render has flashes === 0, so it never flashes.
  const [prevCount, setPrevCount] = useState(count)
  const [flashes, setFlashes] = useState(0)
  if (count !== prevCount) {
    setPrevCount(count)
    setFlashes((n) => n + 1)
  }

  return (
    <ToolbarButton {...button} variant="pill" aria-pressed={pressed}>
      {pressed && (
        <span aria-hidden="true" className="co-tb-check">
          ✓
        </span>
      )}
      {children}
      {count !== undefined && (
        <>
          {' '}
          <span key={flashes} className={flashes > 0 ? 'co-tb-badge co-tb-flash' : 'co-tb-badge'}>
            {count}
          </span>
        </>
      )}
    </ToolbarButton>
  )
}

export function Spinner(): React.ReactElement {
  return <span aria-hidden="true" className="co-tb-spinner" />
}
