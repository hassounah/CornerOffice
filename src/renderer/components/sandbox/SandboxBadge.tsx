import React from 'react'
import { useSandboxStore } from '../../stores/sandbox-store'
import { useOpenCodeExplorer } from '../../utils/code-explorer-nav'
import { RefName } from '../code/RefName'
import { BADGE_HINT_COPY, STOP_UNCONFIRMED_CHIP, forSkin, isSessionStopping } from '../../utils/sandbox-copy'

// ---------------------------------------------------------------------------
// SandboxBadge — the status strip for a workspace's sandbox (TRD §3.15.2,
// UX-H3, SEC-H4): `Sandbox · <branch|detached> · +<ahead> · [Review]` plus
// the states that matter: uncommitted work, unrestricted network, channel
// problems, the Blocked count, and the v2 states `Ending…`, `Docker
// unavailable` and `Stopped unexpectedly` (with reason and a dismiss
// control). The degraded states stay until the next successful start or a
// dismiss, so they aren't only discoverable through an OS notification.
//
// A persistent polite live region (rendered whenever a status exists, even
// when no chip shows, so it is in the DOM before anything changes) announces
// the transitions; the degraded chips carry a next-step hint as a title and
// as an aria-describedby description.
//
// Skin-agnostic logic with a `skin` prop for chrome only; security and
// degraded-state copy is plain and identical in both skins. Branch names are
// agent-writable (SEC-L5), so they render through RefName. `compact` keeps
// the label, Review and every warning (they are safety information) and drops the
// detail chips.
// ---------------------------------------------------------------------------

export interface SandboxBadgeProps {
  slug: string
  skin?: 'office' | 'realm'
  compact?: boolean
  /** Forces this instance's live region on or off. By default exactly one mounted badge per workspace owns it (the first to mount), so a change is announced once wherever the badge is shown. */
  announce?: boolean
  /** Makes the `Blocked N` chip a button that opens Sandbox settings → Network for this workspace. */
  onOpenBlocked?: () => void
}

const REALM_CHIP_STYLE: React.CSSProperties = {
  background: 'rgba(30,20,10,0.6)',
  border: '1px solid rgba(201,168,76,0.3)',
  color: '#e8dcc8',
  fontFamily: 'serif',
}

const REALM_WARN_STYLE: React.CSSProperties = {
  background: 'rgba(224,92,92,0.15)',
  border: '1px solid rgba(224,92,92,0.5)',
  color: '#f0a0a0',
  fontFamily: 'serif',
}

const CHIP_CLASS = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]'
// Visible keyboard focus for the controls in both skins (the Realm chips carry no Tailwind colours of their own).
const FOCUS_CLASS = 'cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#c9a84c]'
const OFFICE_CHIP = `${CHIP_CLASS} border border-co-border bg-co-bg-tertiary text-co-text-secondary`
const OFFICE_WARN = `${CHIP_CLASS} border border-co-status-attention/50 bg-co-status-attention/15 text-co-status-attention`

const EXIT_REASON: Record<'docker-unavailable' | 'exited', string> = {
  'docker-unavailable': 'Docker unavailable',
  exited: 'The session exited',
}

// Live-region ownership: a workspace's badge can be mounted in several places
// at once (workspace page, terminal overlay, Realm study), and a terminal
// overlay may be open with no other badge mounted. So exactly one mounted
// badge per slug owns the live region — the first to mount — and ownership
// moves to the next one when the owner unmounts.
const badgeInstances = new Map<string, string[]>()
const ownershipListeners = new Set<() => void>()

function notifyOwnership(): void {
  for (const listener of ownershipListeners) listener()
}

function subscribeOwnership(listener: () => void): () => void {
  ownershipListeners.add(listener)
  return () => {
    ownershipListeners.delete(listener)
  }
}

function useOwnsLiveRegion(slug: string, mounted: boolean): boolean {
  const id = React.useId()
  React.useEffect(() => {
    if (!mounted) return undefined
    badgeInstances.set(slug, [...(badgeInstances.get(slug) ?? []), id])
    notifyOwnership()
    return () => {
      const rest = (badgeInstances.get(slug) ?? []).filter((x) => x !== id)
      if (rest.length > 0) badgeInstances.set(slug, rest)
      else badgeInstances.delete(slug)
      notifyOwnership()
    }
  }, [slug, mounted, id])
  const owner = React.useSyncExternalStore(subscribeOwnership, () => badgeInstances.get(slug)?.[0] ?? null)
  return owner === id
}

interface HintedChipProps {
  id: string
  hint: string
  className: string | undefined
  style: React.CSSProperties | undefined
  children: React.ReactNode
}

/** A chip whose next step is exposed both as a tooltip (`title`) and as an accessible description. */
function HintedChip({ id, hint, className, style, children }: HintedChipProps): React.ReactElement {
  return (
    <>
      <span className={className} style={style} title={hint} aria-describedby={id}>
        {children}
      </span>
      <span id={id} className="sr-only">
        {hint}
      </span>
    </>
  )
}

export function SandboxBadge({ slug, skin = 'office', compact = false, announce, onOpenBlocked }: SandboxBadgeProps): React.ReactElement | null {
  const status = useSandboxStore((s) => s.status[slug])
  const dockerState = useSandboxStore((s) => s.environment?.docker)
  const blockedCount = useSandboxStore((s) => s.blocked[slug]?.length ?? 0)
  const dismissedAt = useSandboxStore((s) => s.dismissedExit[slug])
  const dismissLastExit = useSandboxStore((s) => s.dismissLastExit)
  const openCodeExplorer = useOpenCodeExplorer()
  const hintId = React.useId()
  const ownsLiveRegion = useOwnsLiveRegion(slug, status !== undefined)

  if (!status) return null

  const isRealm = skin === 'realm'
  const chip = isRealm ? undefined : OFFICE_CHIP
  const warn = isRealm ? undefined : OFFICE_WARN
  const chipStyle = isRealm ? REALM_CHIP_STYLE : undefined
  const warnStyle = isRealm ? REALM_WARN_STYLE : undefined
  const realmChipClass = isRealm ? CHIP_CLASS : undefined

  const { session, git } = status
  const active = session.state === 'running' || session.state === 'preparing'
  const ending = isSessionStopping(session.state)
  const stopUnconfirmed = session.state === 'stop-unconfirmed'
  const lastExit = session.lastExit && session.lastExit.at !== dismissedAt ? session.lastExit : null
  const dockerDown = status.exists && dockerState !== undefined && dockerState !== 'ok'

  const announcement = session.state === 'preparing'
    ? 'Sandbox starting'
    : stopUnconfirmed
      ? 'Sandbox is still stopping'
      : ending
        ? 'Sandbox ending'
        : lastExit
          ? `Sandbox exited with a problem: ${EXIT_REASON[lastExit.reason]}`
          : dockerDown
            ? 'Docker unavailable for the sandbox'
            : active
              ? 'Sandbox running'
              : ''
  const liveRegion = (announce ?? ownsLiveRegion) ? (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </span>
  ) : null

  const showChips = active || ending || lastExit !== null || dockerDown

  const branch = git?.branch ?? null

  // The live region stays the first child in every state, so React keeps the same node and the change is announced.
  return (
    <>
      {liveRegion}
      {showChips && (
    <div role="group" aria-label="Sandbox status" className="inline-flex flex-wrap items-center gap-1">
      {ending &&
        (stopUnconfirmed ? (
          <HintedChip id={`${hintId}-stop`} hint={BADGE_HINT_COPY.stopUnconfirmed} className={chip ?? realmChipClass} style={chipStyle}>
            {STOP_UNCONFIRMED_CHIP}
          </HintedChip>
        ) : (
          <span className={chip ?? realmChipClass} style={chipStyle}>
            Ending…
          </span>
        ))}

      {active && (
        <span className={chip ?? realmChipClass} style={chipStyle}>
          Sandbox
          {session.state === 'preparing' ? (
            <> · Starting…</>
          ) : git ? (
            <>
              {' · '}
              {branch ? <RefName name={branch} /> : 'detached'}
              {` · +${git.ahead}`}
            </>
          ) : null}
        </span>
      )}

      {active && git && (
        <button
          type="button"
          className={`${chip ?? realmChipClass} ${FOCUS_CLASS} underline`}
          style={chipStyle}
          onClick={() =>
            openCodeExplorer(slug, { root: 'sandbox', entry: 'review', changedOnly: true, baseline: 'branch', expectedBranch: branch })
          }
        >
          Review
        </button>
      )}

      {!compact && git && git.dirtyCount > 0 && (
        <span className={chip ?? realmChipClass} style={chipStyle}>
          ● {git.dirtyCount} uncommitted
        </span>
      )}

      {session.networkMode === 'open' && (active || ending) && (
        <span className={warn ?? realmChipClass} style={warnStyle}>
          Unrestricted network
        </span>
      )}

      {status.channel === 'plugin-outdated' && (
        <HintedChip id={`${hintId}-plugin`} hint={BADGE_HINT_COPY.channelPluginOutdated} className={warn ?? realmChipClass} style={warnStyle}>
          Channel: plugin update needed
        </HintedChip>
      )}

      {status.channel === 'unavailable' && (
        <HintedChip id={`${hintId}-channel`} hint={BADGE_HINT_COPY.channelUnavailable} className={warn ?? realmChipClass} style={warnStyle}>
          Channel: unavailable
        </HintedChip>
      )}

      {!compact && blockedCount > 0 &&
        (onOpenBlocked ? (
          <button type="button" className={`${chip ?? realmChipClass} ${FOCUS_CLASS} underline`} style={chipStyle} onClick={onOpenBlocked}>
            Blocked {blockedCount}
          </button>
        ) : (
          <span className={chip ?? realmChipClass} style={chipStyle}>
            Blocked {blockedCount}
          </span>
        ))}

      {dockerDown && lastExit?.reason !== 'docker-unavailable' && (
        <HintedChip id={`${hintId}-docker`} hint={forSkin(BADGE_HINT_COPY.dockerUnavailable, skin)} className={warn ?? realmChipClass} style={warnStyle}>
          Docker unavailable
        </HintedChip>
      )}

      {lastExit && (
        <HintedChip id={`${hintId}-exit`} hint={BADGE_HINT_COPY.stoppedUnexpectedly} className={warn ?? realmChipClass} style={warnStyle}>
          Stopped unexpectedly · {EXIT_REASON[lastExit.reason]}
          <button type="button" aria-label="Dismiss stopped-unexpectedly notice" className={`ml-1 ${FOCUS_CLASS}`} onClick={() => dismissLastExit(slug)}>
            ×
          </button>
        </HintedChip>
      )}
    </div>
      )}
    </>
  )
}
