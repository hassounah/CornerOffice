import React, { useCallback, useEffect, useId, useState } from 'react'
import { useSandboxStore } from '../../stores/sandbox-store'
import { RefName } from '../code/RefName'
import { tokenizeNameToText } from '../../utils/name-safety'

// ---------------------------------------------------------------------------
// UnmergedDot — a small dot shown whenever a workspace's sandbox holds
// unmerged branches, even with no session running (TRD §3.15.2, UX-M3). The
// tooltip lists at most three branch names then "+N more" and has the same
// semantics as DisabledReason's: focusable, `aria-describedby`, visible on
// hover and on keyboard focus, hidden by Escape. Branch names are
// agent-writable (SEC-L5), so they render through RefName.
// ---------------------------------------------------------------------------

const MAX_NAMED_BRANCHES = 3

export interface UnmergedDotProps {
  slug: string
  skin?: 'office' | 'realm'
  /** False inside another interactive control (the workspace card is one button): no extra tab stop there; the label and hover tooltip stay. */
  focusable?: boolean
}

const REALM_TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgba(30,20,10,0.92)',
  color: '#c9a84c',
  border: '1px solid rgba(201,168,76,0.4)',
  fontFamily: 'serif',
}

const TOOLTIP_CLASS = 'absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs whitespace-nowrap z-50 pointer-events-none'

export function UnmergedDot({ slug, skin = 'office', focusable = true }: UnmergedDotProps): React.ReactElement | null {
  const branches = useSandboxStore((s) => s.summaries[slug]?.unmergedBranches)
  const tooltipId = useId()
  const [visible, setVisible] = useState(false)
  const show = useCallback(() => setVisible(true), [])
  const hide = useCallback(() => setVisible(false), [])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, hide])

  if (!branches || branches.length === 0) return null

  const named = branches.slice(0, MAX_NAMED_BRANCHES)
  const more = branches.length - named.length
  const isRealm = skin === 'realm'
  // The dot's own label is plain text (an aria-label cannot hold elements); invisible characters are made visible.
  const label = `Unmerged sandbox work: ${named.map(tokenizeNameToText).join(', ')}${more > 0 ? `, +${more} more` : ''}`

  return (
    <span className="relative inline-flex">
      <span
        role="img"
        tabIndex={focusable ? 0 : undefined}
        aria-label={label}
        aria-describedby={visible ? tooltipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={isRealm ? 'inline-block h-2 w-2 rounded-full' : 'inline-block h-2 w-2 rounded-full bg-co-status-attention'}
        style={isRealm ? { background: '#c9a84c' } : undefined}
      />
      {visible && (
        <span
          id={tooltipId}
          role="tooltip"
          className={isRealm ? `${TOOLTIP_CLASS} rounded` : `${TOOLTIP_CLASS} rounded-md bg-co-bg-tertiary text-co-text-primary border border-co-border shadow-lg`}
          style={isRealm ? REALM_TOOLTIP_STYLE : undefined}
        >
          Unmerged sandbox work:{' '}
          {named.map((name, i) => (
            <React.Fragment key={`${name}-${i}`}>
              {i > 0 && ', '}
              <RefName name={name} />
            </React.Fragment>
          ))}
          {more > 0 && `, +${more} more`}
        </span>
      )}
    </span>
  )
}
