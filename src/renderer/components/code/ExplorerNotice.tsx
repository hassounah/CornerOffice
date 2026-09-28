import React, { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// ExplorerNotice — the one notice/banner primitive every code-explorer
// degraded-state message renders through (TRD §3.9.1, §3.9.2, §3.6.6,
// §3.6.3, §3.8.3). GitStateBanner and the disk-change UI (2.6/2.7/2.16)
// supply copy from notice-copy.ts; this component only handles tone, role,
// persistence, dismiss and an optional row of action buttons.
//
// `tone: 'danger'` and `actions` were added in step 2.13 (extending this
// component rather than creating a second one, per the 2.10 review) for
// consumers like the persistent branch-mismatch banner (§3.8.3, role="alert")
// and the disk-change/secret notices (2.17/2.20, "Reload / Keep mine",
// "Reveal"). There's no separate `persistent` prop: a notice with no
// `autoHideMs` already IS persistent — a second flag that always had to agree
// with the first would just be state that can drift.
// ---------------------------------------------------------------------------

export type NoticeTone = 'info' | 'warning' | 'danger'

export interface ExplorerNoticeAction {
  label: string
  onClick: () => void
}

export interface ExplorerNoticeProps {
  tone: NoticeTone
  /** A plain string for most notices; a mismatch banner renders ref names
   *  through <RefName> here, so this accepts anything renderable rather than
   *  forcing every caller to flatten to a string. */
  message: React.ReactNode
  /** Auto-hides after this many ms — for a notice meant to fade on its own
   *  rather than wait for a dismiss click. Omitted for a persistent notice.
   *  Fix #141: no current caller passes this. TRD §3.9.2's transient
   *  "Reloaded from disk" notice — once cited here as this prop's canonical
   *  example — actually manages its own 4 s timing store-side instead
   *  (code-explorer-store.ts's `scheduleTransientNoteClear`), because this
   *  component's own `autoHideMs` un-mounts the whole node when it fires
   *  (`hidden` → `return null`), which a freshly-inserted `aria-live` region
   *  can't reliably announce; FileHeader.tsx instead pairs a conditionally
   *  visible notice with a separate, permanently-mounted `aria-live` region
   *  whose text just changes. */
  autoHideMs?: number
  /** Renders a dismiss control when given; called once, on click. */
  onDismiss?: () => void
  /** `'alert'` for a notice that must interrupt and be announced immediately
   *  (TRD §3.8.3's branch-mismatch banner). Defaults to `'status'` (polite). */
  role?: 'status' | 'alert'
  /** Extra action buttons alongside the dismiss ×, e.g. "Reload" / "Keep mine". */
  actions?: ExplorerNoticeAction[]
  /** A stable identity for this notice's content (Fix #127): decides whether
   *  the message has "changed" (reset `hidden`, restart `autoHideMs`)
   *  instead of comparing the `message` ReactNode by reference, which
   *  misfires for a message rebuilt fresh every render (e.g. JSX with
   *  <RefName>) — always "new", never equal to itself. Omit it for a plain
   *  string message, where reference equality already does the right thing. */
  id?: string
}

const TONE_CLASSES: Record<NoticeTone, string> = {
  info: 'bg-co-bg-elevated/80 border-white/[0.06] text-co-text-secondary',
  warning: 'bg-co-status-waiting/10 border-co-status-waiting/30 text-co-status-waiting',
  danger: 'bg-co-status-attention/10 border-co-status-attention/30 text-co-status-attention',
}

export function ExplorerNotice({
  tone,
  message,
  autoHideMs,
  onDismiss,
  role = 'status',
  actions,
  id,
}: ExplorerNoticeProps): React.ReactElement | null {
  const [hidden, setHidden] = useState(false)
  // Reset visibility when the content changes, e.g. a reused instance whose
  // auto-hide already fired gets new content to show. Keyed on `id` when the
  // caller supplies one (Fix #127) — a plain reference comparison on
  // `message` would misfire for a ReactNode rebuilt fresh every render (e.g.
  // JSX with <RefName>), which is always "new" even when the content is the
  // same. Falls back to `message` itself (its old behavior) when `id` is
  // omitted, which is exactly right for a plain string message. Set during
  // render (React's documented pattern for "adjusting state when a prop
  // changes"), not in the effect below, so this doesn't trigger a cascading
  // re-render.
  const identity = id ?? message
  const [trackedIdentity, setTrackedIdentity] = useState(identity)
  if (identity !== trackedIdentity) {
    setTrackedIdentity(identity)
    setHidden(false)
  }

  useEffect(() => {
    if (!autoHideMs) return
    const timer = setTimeout(() => setHidden(true), autoHideMs)
    return () => clearTimeout(timer)
  }, [autoHideMs, identity])

  if (hidden) return null

  return (
    <div
      role={role}
      className={[
        'flex items-center gap-2 px-3 py-1.5 text-xs border-b',
        TONE_CLASSES[tone],
      ].join(' ')}
    >
      <span className="flex-1 min-w-0">{message}</span>
      {actions && actions.length > 0 && (
        <span className="flex shrink-0 items-center gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className="underline underline-offset-2 opacity-90 hover:opacity-100"
            >
              {action.label}
            </button>
          ))}
        </span>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 opacity-70 hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  )
}
