import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useSandboxStore } from '../../stores/sandbox-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { DisabledReason } from '../shared/DisabledReason'
import { RecreateDialog } from './RecreateDialog'
import {
  ELIGIBILITY_COPY,
  WARNING_COPY,
  STILL_STOPPING,
  RECREATED_COPY,
  isSessionStopping,
  BUILD_CONFIRM_COPY,
  IMAGE_READY_COPY,
  IMAGE_BUILDING_REASON,
  BUILD_FAILED_COPY,
  UNRESTRICTED_WARNING,
  TRUST_PROMPT_COPY,
  CHECKING_COPY,
  forSkin,
  STATUS_CHECK_TIMEOUT_MS,
  SANDBOX_UNAVAILABLE_COPY,
  isDockerReason,
  PORT_CONFLICT_NO_RECREATE_COPY,
} from '../../utils/sandbox-copy'

// ---------------------------------------------------------------------------
// StartSessionChooser — Host or Sandbox (TRD §3.15.2, §3.16, §14.5, UX-C,
// UX-C2, D10). A popover (Office) or parchment panel (Realm) with a
// role="dialog" and arrow-key navigation; skin-agnostic logic with a `skin`
// prop for chrome only, and the same plain copy in both.
//
// - Sandbox is wrapped in DisabledReason carrying the eligibility copy
//   (including the §14.5 "Run Claude Code on this machine once first"), and
//   shows its warnings when eligible. Selecting it reveals Permissions (Skip
//   permissions by default / Auto mode) and Network (Allowlist by default /
//   Unrestricted, with a warning line).
// - Build flow (UX-C): on IMAGE_MISSING the terminal store opens `buildPrompt`;
//   the chooser asks to build (size and time), shows progress with "Show log",
//   and when the build finishes says "Image ready" with an explicit Start and
//   the same toggles. NOTHING here calls startSession except the Start button:
//   a build never starts a session.
// - RECREATE_REQUIRED opens the RecreateDialog with the plan from the status.
//   PORT_CONFLICT offers "Recreate with a new port" through the same dialog.
// - Dialog behaviour: every panel takes focus on mount and on each panel swap,
//   Tab is trapped inside, Escape closes (scoped to the dialog, so a nested
//   RecreateDialog or a DisabledReason tooltip handles its own first), and
//   closing clears the build and recreate prompts and the spawn error so a
//   later open never shows a stale panel. A build that finished before the
//   chooser mounted is not replayed.
// ---------------------------------------------------------------------------

export interface StartSessionChooserProps {
  slug: string
  skin?: 'office' | 'realm'
  /** The Host option's start (the existing host spawn). */
  onStartHost: () => void
  onClose: () => void
  /** Opens Sandbox settings (the build log lives there). The "Show log" link only renders when given. */
  onShowLog?: () => void
  /** Where focus goes when the chooser closes: the Start Session button that opened it. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

type Mode = 'host' | 'sandbox'
type PermissionMode = 'skip' | 'auto'
type NetworkMode = 'allowlist' | 'open'

// A focusable control that is not a roving-tabindex radio (those use `tabIndex=-1`).
const TABBABLE = 'button:not([tabindex="-1"]), [tabindex="0"]'

const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#c9a84c]'

const REALM_PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(10,6,2,0.92)',
  border: '1px solid #c9a84c',
  borderRadius: 4,
  color: '#e8dcc8',
  fontFamily: 'serif',
}
const REALM_BUTTON_STYLE: React.CSSProperties = { background: 'rgba(201,168,76,0.15)', border: '1px solid #c9a84c', color: '#c9a84c', fontFamily: 'serif' }
const REALM_SELECTED_STYLE: React.CSSProperties = { ...REALM_BUTTON_STYLE, background: 'rgba(201,168,76,0.35)' }

interface Choice<T extends string> {
  value: T
  label: string
}

/**
 * A segmented control with radio semantics: roving tabindex, arrow keys move
 * the focus, Enter or Space selects (a native button's click). `isDisabled`
 * options stay focusable (so their reason can be read) but can't be selected.
 */
function Segmented<T extends string>({
  label,
  choices,
  value,
  onChange,
  skin,
  wrap,
}: {
  label: string
  choices: readonly Choice<T>[]
  value: T
  onChange: (v: T) => void
  skin: 'office' | 'realm'
  /** Lets the caller wrap an option (e.g. in DisabledReason). Returns the props to spread onto the option, or null for enabled. */
  wrap?: (choice: Choice<T>, render: (props: React.HTMLAttributes<HTMLButtonElement> | null) => React.ReactElement) => React.ReactElement
}): React.ReactElement {
  const groupId = useId()

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const radios = (e.currentTarget as HTMLElement).closest('[role="radiogroup"]')?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    radios?.[(index + step + choices.length) % choices.length]?.focus()
  }

  return (
    <div role="radiogroup" aria-labelledby={groupId} className="space-y-1">
      <div id={groupId} className="text-xs font-medium">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {choices.map((choice, i) => {
          const selected = choice.value === value
          const render = (props: React.HTMLAttributes<HTMLButtonElement> | null): React.ReactElement => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className={`rounded px-3 py-1 text-sm ${FOCUS} ${skin === 'realm' ? '' : selected ? 'bg-co-accent/20 text-co-accent' : 'bg-co-bg-tertiary text-co-text-secondary'}`}
              style={skin === 'realm' ? (selected ? REALM_SELECTED_STYLE : REALM_BUTTON_STYLE) : undefined}
              onClick={() => onChange(choice.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              {...(props ?? {})}
            >
              {choice.label}
            </button>
          )
          return wrap ? <React.Fragment key={choice.value}>{wrap(choice, render)}</React.Fragment> : render(null)
        })}
      </div>
    </div>
  )
}

const MODES: readonly Choice<Mode>[] = [
  { value: 'host', label: 'Host' },
  { value: 'sandbox', label: 'Sandbox' },
]
const PERMISSIONS: readonly Choice<PermissionMode>[] = [
  { value: 'skip', label: 'Skip permissions' },
  { value: 'auto', label: 'Auto mode' },
]
const NETWORKS: readonly Choice<NetworkMode>[] = [
  { value: 'allowlist', label: 'Allowlist' },
  { value: 'open', label: 'Unrestricted' },
]

/** Moves focus into the terminal overlay of a session that just started; retried once, since the overlay may mount a tick later. */
function focusTerminal(slug: string): void {
  const focus = (): boolean => {
    const overlay = document.querySelector<HTMLElement>(`[data-terminal-overlay="${CSS.escape(slug)}"]`)
    if (!overlay) return false
    // The terminal focuses its own input when it is ready: never take focus back from it.
    if (overlay.contains(document.activeElement)) return true
    ;(overlay.querySelector<HTMLElement>('.xterm-helper-textarea') ?? overlay).focus()
    return true
  }
  if (!focus()) setTimeout(focus, 0)
}

export function StartSessionChooser({ slug, skin = 'office', onStartHost, onClose, onShowLog, returnFocusRef }: StartSessionChooserProps): React.ReactElement {
  const status = useSandboxStore((s) => s.status[slug])
  const build = useSandboxStore((s) => s.build)
  const fetchStatus = useSandboxStore((s) => s.fetchStatus)
  const fetchEnvironment = useSandboxStore((s) => s.fetchEnvironment)
  const buildImage = useSandboxStore((s) => s.buildImage)
  const releaseBuildRequest = useSandboxStore((s) => s.releaseBuildRequest)
  const spawn = useTerminalStore((s) => s.spawn)
  const buildPrompt = useTerminalStore((s) => s.buildPrompt[slug] ?? null)
  const recreatePrompt = useTerminalStore((s) => s.recreatePrompt[slug] ?? null)
  const spawnError = useTerminalStore((s) => s.spawnError[slug] ?? null)
  const spawnFailure = useTerminalStore((s) => s.spawnFailure[slug] ?? null)
  const starting = useTerminalStore((s) => s.sessions[slug] === 'starting')
  const clearBuildPrompt = useTerminalStore((s) => s.clearBuildPrompt)
  const clearRecreatePrompt = useTerminalStore((s) => s.clearRecreatePrompt)
  const clearSpawnError = useTerminalStore((s) => s.clearSpawnError)

  const [mode, setMode] = useState<Mode>('host')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('skip')
  const [networkMode, setNetworkMode] = useState<NetworkMode>('allowlist')
  const [portRecreate, setPortRecreate] = useState(false)
  const [recreated, setRecreated] = useState(false)
  const [buildError, setBuildError] = useState(false)
  const [readyAcknowledged, setReadyAcknowledged] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkedSlug, setCheckedSlug] = useState<string | null>(null)
  const statusChecked = checkedSlug === slug
  const [restoredFor, setRestoredFor] = useState<unknown>(null)
  const titleId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  // Synchronous guards: a second click in the same tick must not start a second spawn or build.
  const startInFlight = useRef(false)
  const buildInFlight = useRef(false)
  const checkInFlight = useRef(false)
  // Once a session started, focus belongs to its terminal, not to the Start button that is going away.
  const startedRef = useRef(false)
  const refocusAfterCheck = useRef(false)

  // Prompts, the spawn error and a finished build's request belong to one opening of the chooser.
  const reset = useCallback((): void => {
    clearBuildPrompt(slug)
    clearRecreatePrompt(slug)
    clearSpawnError(slug)
    releaseBuildRequest()
  }, [slug, clearBuildPrompt, clearRecreatePrompt, clearSpawnError, releaseBuildRequest])

  const close = useCallback((): void => {
    reset()
    onClose()
  }, [reset, onClose])

  // A build that finished before this opening is stale; one that finishes while mounted is shown.
  useEffect(() => {
    releaseBuildRequest()
    return reset
  }, [reset, releaseBuildRequest])

  // The store keeps the last status when a fetch fails, so "still no status once the fetch settled" means it failed.
  useEffect(() => {
    let current = true
    const settle = (): void => {
      if (current) setCheckedSlug(slug)
    }
    void Promise.all([fetchStatus(slug), fetchEnvironment(false)]).then(settle)
    // A fetch that never settles must not leave "Checking…" with no way out.
    const timer = setTimeout(settle, STATUS_CHECK_TIMEOUT_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [slug, fetchStatus, fetchEnvironment])

  // Focus returns to the control that opened the chooser.
  useEffect(() => {
    const target = returnFocusRef?.current
    return () => {
      if (!startedRef.current && target?.isConnected) target.focus()
    }
  }, [returnFocusRef])

  // After a build for THIS workspace finishes, the toggles come back as the user had them, and Start is explicit.
  const buildFor = build.requestedFor?.slug === slug ? build.requestedFor : null
  const imageReady = buildFor !== null && build.phase === 'done' && !build.running && !readyAcknowledged
  const buildRunning = buildFor !== null && build.running
  const buildFailed = buildFor !== null && !build.running && (build.phase === 'failed' || build.phase === 'cancelled')
  // Adjusting state while rendering (React's documented pattern for state derived from a transition), once per finished build.
  if (imageReady && buildFor && !restoredFor) {
    setRestoredFor(buildFor)
    setMode('sandbox')
    setPermissionMode(buildFor.permissionMode)
    setNetworkMode(buildFor.networkMode)
  } else if (!imageReady && restoredFor) {
    setRestoredFor(null)
  }

  const eligibility = status?.eligibility
  const statusFailed = !status && statusChecked
  const ineligibleReason = eligibility && !eligibility.ok ? ELIGIBILITY_COPY[eligibility.reason] : !status ? (statusChecked ? SANDBOX_UNAVAILABLE_COPY : CHECKING_COPY) : null
  const dockerIneligible = eligibility && !eligibility.ok && isDockerReason(eligibility.reason)
  // Docker reasons and a failed status fetch both end in "try again": one button serves both.
  const canCheckAgain = dockerIneligible || statusFailed
  const sandboxEligible = eligibility?.ok === true
  const warnings = eligibility?.ok ? eligibility.warnings : []
  const ending = isSessionStopping(status?.session.state)
  const sandbox = mode === 'sandbox'

  const startBlockedReason = starting ? 'Starting…' : sandbox && ending ? STILL_STOPPING : sandbox && buildRunning ? IMAGE_BUILDING_REASON : null
  const recreatePlan = status?.recreatePlan ?? null
  const canRecreateForPort = spawnFailure === 'PORT_CONFLICT' && recreatePlan?.reason === 'port'

  async function start(): Promise<void> {
    if (startInFlight.current) return
    startInFlight.current = true
    try {
      if (!sandbox) {
        // The host start is synchronous and closes the chooser: the guard stays set so a second click can't start another.
        onStartHost()
        startedRef.current = true
        close()
        focusTerminal(slug)
        return
      }
      setReadyAcknowledged(true)
      setRecreated(false)
      setBuildError(false)
      await spawn(slug, { kind: 'sandbox', permissionMode, networkMode })
      if (useTerminalStore.getState().sessions[slug] === 'running') {
        startedRef.current = true
        close()
        focusTerminal(slug)
      }
    } finally {
      if (sandbox) startInFlight.current = false
    }
  }

  // The Docker reasons say "press Check again": this is that button, so the chooser is never a dead end.
  async function checkAgain(): Promise<void> {
    if (checkInFlight.current) return
    checkInFlight.current = true
    setChecking(true)
    refocusAfterCheck.current = true
    try {
      await fetchEnvironment(true)
      await fetchStatus(slug)
    } finally {
      checkInFlight.current = false
      setChecking(false)
    }
  }

  // The button disappears once Docker is fine; focus moves to the selected option instead of dropping to the page.
  useEffect(() => {
    if (!refocusAfterCheck.current || checking) return
    // A failed check must not leave the request armed: it would steal focus when Docker comes back later.
    refocusAfterCheck.current = false
    if (canCheckAgain) return
    rootRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus()
  }, [checking, canCheckAgain])

  async function confirmBuild(): Promise<void> {
    if (buildInFlight.current) return
    buildInFlight.current = true
    const request = { slug, permissionMode: buildPrompt?.permissionMode ?? permissionMode, networkMode: buildPrompt?.networkMode ?? networkMode }
    clearBuildPrompt(slug)
    setBuildError(false)
    setReadyAcknowledged(false)
    try {
      await buildImage(false, request)
    } catch {
      setBuildError(true)
    } finally {
      buildInFlight.current = false
    }
  }

  // Which panel is showing. A swap, or a nested dialog closing, puts focus back inside the chooser.
  const panel = recreatePrompt ? 'recreate' : buildPrompt ? 'build' : 'main'
  useEffect(() => {
    // The RecreateDialog (a modal <dialog>) manages its own focus, both as a whole panel and nested.
    if (panel === 'recreate' || portRecreate) return
    const root = rootRef.current
    const target = root?.querySelector<HTMLElement>('[data-autofocus], [role="radio"][aria-checked="true"]') ?? root?.querySelector<HTMLElement>('h2')
    target?.focus()
  }, [panel, portRecreate])

  function onDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const root = rootRef.current
    if (!root) return
    if (e.key === 'Escape') {
      // An open DisabledReason tooltip hides itself on this same Escape; the chooser stays for it.
      if (root.querySelector('[role="tooltip"]')) return
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'Tab' || root.querySelector('dialog')) return
    const items = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE))
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const panelClass = skin === 'realm' ? 'w-80 space-y-3 p-4 text-sm' : 'w-80 space-y-3 rounded-lg border border-co-border bg-co-bg-secondary p-4 text-sm text-co-text-primary shadow-lg'
  const buttonClass = `rounded px-3 py-1.5 text-sm ${FOCUS} ${skin === 'realm' ? '' : 'bg-co-bg-tertiary text-co-text-primary hover:bg-co-bg-elevated'}`
  const buttonStyle = skin === 'realm' ? REALM_BUTTON_STYLE : undefined

  // ── Recreate flows (RECREATE_REQUIRED, PORT_CONFLICT) ──────────────────────
  if (recreatePrompt) {
    return (
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onDialogKeyDown} className={panelClass} style={skin === 'realm' ? REALM_PANEL_STYLE : undefined}>
        <h2 id={titleId} tabIndex={-1} className="text-sm font-semibold">
          Start a session
        </h2>
        <RecreateDialog
          slug={slug}
          plan={recreatePrompt.plan}
          skin={skin}
          onRecreated={() => {
            clearRecreatePrompt(slug)
            setRecreated(true)
          }}
          onCancel={() => clearRecreatePrompt(slug)}
        />
      </div>
    )
  }

  // ── Build confirm (IMAGE_MISSING) ──────────────────────────────────────────
  if (buildPrompt) {
    return (
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onDialogKeyDown} className={panelClass} style={skin === 'realm' ? REALM_PANEL_STYLE : undefined}>
        <h2 id={titleId} tabIndex={-1} className="text-sm font-semibold">
          Build the sandbox image?
        </h2>
        <p>{BUILD_CONFIRM_COPY}</p>
        <div className="flex justify-end gap-2">
          <button type="button" data-autofocus className={buttonClass} style={buttonStyle} onClick={() => clearBuildPrompt(slug)}>
            Cancel
          </button>
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void confirmBuild()}>
            Build
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onDialogKeyDown} className={panelClass} style={skin === 'realm' ? REALM_PANEL_STYLE : undefined}>
      <h2 id={titleId} tabIndex={-1} className="text-sm font-semibold">
        Start a session
      </h2>

      <Segmented
        label="Run Claude Code"
        choices={MODES}
        value={mode}
        skin={skin}
        onChange={(v) => {
          // The Sandbox option is explained, not selectable, while it is ineligible.
          if (v === 'sandbox' && !sandboxEligible) return
          setMode(v)
        }}
        wrap={(choice, render) =>
          choice.value === 'sandbox' ? (
            <DisabledReason reason={ineligibleReason} skin={skin}>
              {(props) => render(props)}
            </DisabledReason>
          ) : (
            render(null)
          )
        }
      />

      {canCheckAgain && (
        <DisabledReason reason={checking ? CHECKING_COPY : null} skin={skin}>
          {(props) => (
            <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void checkAgain()} {...props}>
              {checking ? 'Checking…' : 'Check again'}
            </button>
          )}
        </DisabledReason>
      )}

      {sandboxEligible && warnings.length > 0 && (
        <ul className="space-y-1 text-xs">
          {warnings.map((w) => (
            <li key={w}>{forSkin(WARNING_COPY[w], skin)}</li>
          ))}
        </ul>
      )}

      {sandbox && (
        <>
          <Segmented label="Permissions" choices={PERMISSIONS} value={permissionMode} onChange={setPermissionMode} skin={skin} />
          <Segmented label="Network" choices={NETWORKS} value={networkMode} onChange={setNetworkMode} skin={skin} />
          {/* The region exists before the warning does, so toggling Unrestricted is announced. */}
          <div aria-live="polite" aria-atomic="true" data-testid="network-announcer">
            {networkMode === 'open' && <p className="text-xs font-medium">{UNRESTRICTED_WARNING}</p>}
          </div>
          <p className="text-xs">{TRUST_PROMPT_COPY}</p>
        </>
      )}

      {imageReady && (
        <p role="status" className="font-medium">
          {IMAGE_READY_COPY}
        </p>
      )}

      {buildRunning && (
        <p role="status" className="text-xs">
          Building the image… {build.lines.at(-1) ?? ''}{' '}
          {onShowLog && (
            <button type="button" className={`underline ${FOCUS}`} onClick={onShowLog}>
              Show log
            </button>
          )}
        </p>
      )}

      {(buildFailed || buildError) && (
        <p role="alert" className="text-xs">
          {BUILD_FAILED_COPY}
        </p>
      )}

      {recreated && (
        <p role="status" className="text-xs">
          {RECREATED_COPY}
        </p>
      )}

      {spawnError && (
        <div role="alert" className="space-y-1 text-xs">
          <p>{spawnFailure === 'PORT_CONFLICT' && !canRecreateForPort ? PORT_CONFLICT_NO_RECREATE_COPY : spawnError}</p>
          {canRecreateForPort && (
            <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setPortRecreate(true)}>
              Recreate with a new port
            </button>
          )}
        </div>
      )}

      {portRecreate && recreatePlan && (
        <RecreateDialog
          slug={slug}
          plan={recreatePlan}
          newPort
          skin={skin}
          onRecreated={() => {
            setPortRecreate(false)
            clearSpawnError(slug)
            setRecreated(true)
          }}
          onCancel={() => setPortRecreate(false)}
        />
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} style={buttonStyle} onClick={close}>
          Cancel
        </button>
        <DisabledReason reason={startBlockedReason} skin={skin}>
          {(props) => (
            <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void start()} {...props}>
              Start
            </button>
          )}
        </DisabledReason>
      </div>
    </div>
  )
}
