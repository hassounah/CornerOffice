import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useSandboxStore } from '../../stores/sandbox-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { DisabledReason } from '../shared/DisabledReason'
import { RecreateDialog } from './RecreateDialog'
import { CopyCommand } from './CopyCommand'
import { AGENT_DESCRIPTORS, LEGACY_AGENT_ID, getDescriptor } from '@main/agents/descriptors'
import type { AgentId } from '@main/agents/descriptors'
import type { AgentDescriptor, AppPermissionMode, PermissionChoice, SessionLocation } from '@main/agents/types'
import type { SessionChoice } from '@main/types/config'
import type { SessionDefaultsView } from '@main/services/session-defaults'
import type { ChoiceSource } from '../../utils/session-options'
import { loadAvailability, loadDefaults, useChooserChoice } from './use-chooser-choice'
import type { HostAvailability, NetworkMode } from './use-chooser-choice'
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
  CHECKING_COPY,
  forSkin,
  STATUS_CHECK_TIMEOUT_MS,
  SANDBOX_UNAVAILABLE_COPY,
  agentReadinessMessage,
  agentReadinessCommand,
  imageUpdatedForAgentCopy,
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
  /** The remembered (or resolved) options to start from; the built-in choice when absent. */
  initial?: { choice: SessionChoice; source: ChoiceSource }
  /** The agents offered; every registered agent by default. A test seam. */
  agents?: readonly AgentDescriptor[]
  onClose: () => void
  /** Opens Sandbox settings (the build log lives there). The "Show log" link only renders when given. */
  onShowLog?: () => void
  /** Where focus goes when the chooser closes: the Start Session button that opened it. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

type Mode = SessionLocation
type SandboxPermission = 'skip' | 'auto'

/** The helper label next to Reset, from where the starting choice came from. */
const SOURCE_LABEL: Record<ChoiceSource, string | null> = {
  workspace: 'Remembered for this workspace',
  last: 'Last used',
  builtin: null,
}

const RESET_TOOLTIP = 'Resets these choices. Nothing is saved until you start.'

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
  autoFocusSelected,
}: {
  label: string
  choices: readonly Choice<T>[]
  value: T
  onChange: (v: T) => void
  skin: 'office' | 'realm'
  /** Marks the selected radio as the dialog's initial focus (the first control a notice replaced). */
  autoFocusSelected?: boolean
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
              data-autofocus={selected && autoFocusSelected ? true : undefined}
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

/**
 * The Permissions row for the current agent and location (TRD §4.6). One offered
 * mode is a static line (nothing to choose); several are a radio group. Either
 * way the selected mode's note is shown.
 */
function PermissionRow({
  choices,
  value,
  onChange,
  skin,
  autoFocusSelected,
}: {
  choices: readonly PermissionChoice[]
  value: string
  onChange: (mode: string) => void
  skin: 'office' | 'realm'
  autoFocusSelected?: boolean
}): React.ReactElement | null {
  const selected = choices.find((c) => c.mode === value) ?? choices[0]
  if (!selected) return null
  if (choices.length === 1) {
    return (
      <div data-testid="permission-static" className="space-y-1">
        <div className="text-xs font-medium">Permissions</div>
        <p className="text-sm">{selected.label}</p>
        <p className="text-xs">{selected.note}</p>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <Segmented
        label="Permissions"
        choices={choices.map((c) => ({ value: c.mode, label: c.label }))}
        value={selected.mode}
        onChange={onChange}
        skin={skin}
        autoFocusSelected={autoFocusSelected}
      />
      <p className="text-xs" data-testid="permission-note">
        {selected.note}
      </p>
    </div>
  )
}

/** The "Will start" summary: what Start will do, in the order of the rows above it. */
function willStartText(agentName: string, mode: Mode, permissionLabel: string, networkMode: NetworkMode): string {
  const parts = [agentName, mode === 'host' ? 'Host' : 'Sandbox', permissionLabel]
  if (mode === 'sandbox') parts.push(networkMode === 'open' ? 'Unrestricted' : 'Allowlist')
  return parts.join(' · ')
}

/** Keeps a remembered mode only if the agent still offers it at this location; otherwise that location's first (default) mode. */
function offeredMode(choices: readonly PermissionChoice[], mode: string): string {
  return choices.some((c) => c.mode === mode) ? mode : (choices[0]?.mode ?? mode)
}

/** Keyed by workspace: another workspace is a new opening, with its own fetch, touched fields and notices. */
export function StartSessionChooser(props: StartSessionChooserProps): React.ReactElement {
  return <StartSessionChooserInner key={props.slug} {...props} />
}

function StartSessionChooserInner({
  slug,
  skin = 'office',
  initial,
  agents = AGENT_DESCRIPTORS,
  onClose,
  onShowLog,
  returnFocusRef,
}: StartSessionChooserProps): React.ReactElement {
  const status = useSandboxStore((s) => s.status[slug])
  const build = useSandboxStore((s) => s.build)
  const fetchStatus = useSandboxStore((s) => s.fetchStatus)
  const fetchEnvironment = useSandboxStore((s) => s.fetchEnvironment)
  const buildImage = useSandboxStore((s) => s.buildImage)
  const releaseBuildRequest = useSandboxStore((s) => s.releaseBuildRequest)
  const spawn = useTerminalStore((s) => s.spawn)
  const buildPrompt = useTerminalStore((s) => s.buildPrompt[slug] ?? null)
  const imageExists = useSandboxStore((s) => s.environment?.image.state === 'ready' || s.environment?.image.state === 'stale')
  const recreatePrompt = useTerminalStore((s) => s.recreatePrompt[slug] ?? null)
  const spawnError = useTerminalStore((s) => s.spawnError[slug] ?? null)
  const spawnFailure = useTerminalStore((s) => s.spawnFailure[slug] ?? null)
  const starting = useTerminalStore((s) => s.sessions[slug] === 'starting')
  const clearBuildPrompt = useTerminalStore((s) => s.clearBuildPrompt)
  const clearRecreatePrompt = useTerminalStore((s) => s.clearRecreatePrompt)
  const clearSpawnError = useTerminalStore((s) => s.clearSpawnError)

  const choice = useChooserChoice({ slug, initial, agents })
  // A pre-resolved `initial` skips the open-time resolution (a test seam; the app never passes one).
  const preResolved = initial !== undefined
  // Advisory only (D19): a PATH miss is flagged, never swapped or blocked.
  const [availability, setAvailability] = useState<HostAvailability | null>(null)
  const { agentId, mode, hostPermission, sandboxPermission, networkMode, source, notices, replaced, recheckOutcome, resolved, resolveWith } = choice
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

  /**
   * The one bounded fetch behind both the open and "Check again" (D18): the environment (then the status it
   * feeds), the remembered options and the host availability settle together, or the timeout does. `onSettled`
   * runs once with the options that arrived; the returned function cancels it. The store keeps the last status
   * when a fetch fails, so "still no status once the fetch settled" means it failed.
   */
  const fetchAll = useCallback(
    (onSettled: (defaults: SessionDefaultsView | null) => void): (() => void) => {
      let live = true
      let settled = false
      let defaults: SessionDefaultsView | null = null
      const settle = (): void => {
        if (!live || settled) return
        settled = true
        onSettled(defaults)
      }
      const fetched = [
        // The status reads the Docker state the refresh just probed, so it waits for the environment.
        fetchEnvironment(true).then(() => fetchStatus(slug)),
        loadDefaults(slug).then((view) => {
          defaults = view
        }),
        loadAvailability(true).then((found) => {
          if (live) setAvailability(found)
        }),
      ]
      void Promise.all(fetched).then(settle)
      // A fetch that never settles must not leave the skeleton or "Checking…" with no way out.
      const timer = setTimeout(settle, STATUS_CHECK_TIMEOUT_MS)
      return () => {
        live = false
        clearTimeout(timer)
      }
    },
    [slug, fetchStatus, fetchEnvironment],
  )

  useEffect(
    () =>
      fetchAll((defaults) => {
        setCheckedSlug(slug)
        if (!preResolved) resolveWith(defaults, useSandboxStore.getState().status[slug])
      }),
    [fetchAll, slug, preResolved, resolveWith],
  )

  // A "Check again" that is still running when the chooser goes away must not touch it afterwards.
  const recheckCancel = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      recheckCancel.current?.()
      recheckCancel.current = null
    },
    [],
  )

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
    choice.restoreSandbox(buildFor.permissionMode, buildFor.networkMode)
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

  const descriptorOf = (id: AgentId): AgentDescriptor => agents.find((d) => d.id === id) ?? getDescriptor(id)
  const descriptor = descriptorOf(agentId)
  const permissionChoices = descriptor.permissionModes[mode]
  const permissionMode = offeredMode(permissionChoices, sandbox ? sandboxPermission : hostPermission)
  const permissionLabel = permissionChoices.find((c) => c.mode === permissionMode)?.label ?? permissionMode
  const agentHasSandbox = descriptor.permissionModes.sandbox.length > 0
  // Why Sandbox can't be chosen right now: the workspace or Docker first, then this agent's own readiness (UX-M8: the
  // descriptor's copy is the one source). `null` means it can.
  const readinessCode = status?.agentReadiness?.[agentId]?.code
  const readinessReason = readinessCode ? (agentReadinessMessage(agentId, readinessCode) ?? SANDBOX_UNAVAILABLE_COPY) : null
  const sandboxReason = !agentHasSandbox ? `${descriptor.displayName} isn't available in the sandbox yet.` : (ineligibleReason ?? readinessReason)
  // The fix, when this agent's own readiness is what blocks the sandbox (not Docker or the workspace).
  const readinessCommand = agentHasSandbox && !ineligibleReason && readinessCode ? agentReadinessCommand(agentId, readinessCode) : null
  const warnStart = permissionMode === 'skip' || (sandbox && networkMode === 'open')
  const willStartId = `${titleId}-will-start`
  const networkWarningId = `${titleId}-network-warning`
  const firstRunNote = sandbox ? descriptor.copy.sandboxFirstRunNote : descriptor.copy.hostFirstRunNote

  const startBlockedReason = starting ? 'Starting…' : sandbox && ending ? STILL_STOPPING : sandbox && buildRunning ? IMAGE_BUILDING_REASON : null
  const recreatePlan = status?.recreatePlan ?? null
  const canRecreateForPort = spawnFailure === 'PORT_CONFLICT' && recreatePlan?.reason === 'port'

  async function start(): Promise<void> {
    if (startInFlight.current) return
    startInFlight.current = true
    try {
      if (!sandbox) {
        // The store marks the session 'starting' synchronously, so the chooser closes at once; the guard stays set so a second click can't start another.
        void spawn(slug, { kind: 'host', agentId, permissionMode: permissionMode as AppPermissionMode, fallbackFields: replaced })
        startedRef.current = true
        close()
        focusTerminal(slug)
        return
      }
      setReadyAcknowledged(true)
      setRecreated(false)
      setBuildError(false)
      await spawn(slug, { kind: 'sandbox', agentId, permissionMode: permissionMode as SandboxPermission, networkMode, fallbackFields: replaced })
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
  function checkAgain(): void {
    if (checkInFlight.current) return
    checkInFlight.current = true
    setChecking(true)
    refocusAfterCheck.current = true
    recheckCancel.current = fetchAll((defaults) => {
      recheckCancel.current = null
      // The one exception to "resolve once" (UX H2): re-resolve whatever the user hasn't touched.
      resolveWith(defaults, useSandboxStore.getState().status[slug], { recheck: true })
      checkInFlight.current = false
      setChecking(false)
    })
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
    const request = { slug, permissionMode: buildPrompt?.permissionMode ?? (permissionMode as SandboxPermission), networkMode: buildPrompt?.networkMode ?? networkMode }
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
    // Start when nothing was replaced; otherwise the first replaced control (both marked `data-autofocus`).
    const target =
      root?.querySelector<HTMLElement>('[data-autofocus]') ??
      root?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      root?.querySelector<HTMLElement>('h2')
    target?.focus()
  }, [panel, portRecreate, resolved])

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
        {/* An existing image that predates the chosen agent is rebuilt once to include it. */}
        {imageExists && buildPrompt.agentId && buildPrompt.agentId !== LEGACY_AGENT_ID && <p>{imageUpdatedForAgentCopy(buildPrompt.agentId)}</p>}
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

  // The live region exists from mount, empty, so the notices that arrive after the skeleton are announced.
  const noticesRegion = (
    <div aria-live="polite" data-testid="notices-region" className="space-y-1">
      {resolved && notices.length > 0 && (
        <ul data-testid="notices" className="space-y-1 text-xs">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}
      {resolved && notices.length === 0 && recheckOutcome && (
        <p data-testid="notices-outcome" className="text-xs">
          {recheckOutcome}
        </p>
      )}
    </div>
  )

  // ── Skeleton until the open-time fetch settles or times out ────────────────
  if (!resolved) {
    return (
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy="true" onKeyDown={onDialogKeyDown} className={panelClass} style={skin === 'realm' ? REALM_PANEL_STYLE : undefined}>
        <h2 id={titleId} tabIndex={-1} className="text-sm font-semibold">
          Start a session
        </h2>
        {noticesRegion}
        <p data-testid="chooser-skeleton" className="text-xs">
          {CHECKING_COPY}
        </p>
        <div className="flex justify-end">
          <button type="button" className={buttonClass} style={buttonStyle} onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const firstReplaced = notices.length > 0 ? replaced[0] : undefined
  // Is there a replaced control on screen to land on? A hidden Agent row or a static single-mode row has none.
  const replacedControlShown =
    firstReplaced === 'agentId' ? agents.length > 1 : firstReplaced === 'permissionMode' ? permissionChoices.length > 1 : firstReplaced !== undefined

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onDialogKeyDown} className={panelClass} style={skin === 'realm' ? REALM_PANEL_STYLE : undefined}>
      <h2 id={titleId} tabIndex={-1} className="text-sm font-semibold">
        Start a session
      </h2>

      {noticesRegion}

      {(canCheckAgain || notices.length > 0 || recheckOutcome !== null) && (
        <DisabledReason reason={checking ? CHECKING_COPY : null} skin={skin}>
          {(props) => (
            <button
              type="button"
              className={buttonClass}
              style={buttonStyle}
              onClick={checkAgain}
              // Notices without a replaced control to land on (a static row, a timeout): focus the way forward.
              data-autofocus={notices.length > 0 && !replacedControlShown ? true : undefined}
              {...props}
            >
              {checking ? 'Checking…' : 'Check again'}
            </button>
          )}
        </DisabledReason>
      )}

      <div className="flex items-center justify-between gap-2 text-xs">
        <span data-testid="choice-source">{SOURCE_LABEL[source]}</span>
        <button type="button" title={RESET_TOOLTIP} className={`underline ${FOCUS}`} onClick={choice.resetChoices}>
          Reset
        </button>
      </div>

      {agents.length > 1 && (
        <Segmented
          label="Agent"
          choices={agents.map((d) => ({
            value: d.id as AgentId,
            label: availability?.[d.id] === 'not-found' ? `${d.displayName} (may not be installed)` : d.displayName,
          }))}
          value={agentId}
          skin={skin}
          onChange={choice.chooseAgent}
          autoFocusSelected={firstReplaced === 'agentId'}
        />
      )}

      {!sandbox && availability?.[agentId] === 'not-found' && (
        <p data-testid="path-warning" className="text-xs">
          <code>{descriptor.binaryName}</code> wasn&apos;t found on your PATH, so it may not be installed. Start may still work if your shell finds it.
        </p>
      )}

      <Segmented
        label="Where"
        choices={MODES}
        value={mode}
        skin={skin}
        autoFocusSelected={firstReplaced === 'location'}
        onChange={(v) => {
          // The Sandbox option is explained, not selectable, while it is ineligible or the agent has no sandbox half.
          if (v === 'sandbox' && sandboxReason !== null) return
          choice.chooseMode(v)
        }}
        wrap={(choice, render) =>
          choice.value === 'sandbox' ? (
            <DisabledReason reason={sandboxReason} skin={skin}>
              {(props) => render(props)}
            </DisabledReason>
          ) : (
            render(null)
          )
        }
      />

      {readinessCommand && (
        <p data-testid="readiness-command" className="text-xs">
          To use the sandbox with {descriptor.displayName}, run: <CopyCommand command={readinessCommand} buttonClass={buttonClass} buttonStyle={buttonStyle} />
        </p>
      )}

      {sandboxEligible && warnings.length > 0 && (
        <ul className="space-y-1 text-xs">
          {warnings.map((w) => (
            <li key={w}>{forSkin(WARNING_COPY[w], skin)}</li>
          ))}
        </ul>
      )}

      <PermissionRow
        choices={permissionChoices}
        value={permissionMode}
        onChange={choice.choosePermission}
        skin={skin}
        autoFocusSelected={firstReplaced === 'permissionMode'}
      />

      {sandbox && (
        <>
          <Segmented label="Network" choices={NETWORKS} value={networkMode} onChange={choice.chooseNetwork} skin={skin} />
          {/* The region exists before the warning does, so toggling Unrestricted is announced. */}
          <div aria-live="polite" aria-atomic="true" data-testid="network-announcer">
            {networkMode === 'open' && (
              <p id={networkWarningId} className="text-xs font-medium">
                {UNRESTRICTED_WARNING}
              </p>
            )}
          </div>
        </>
      )}

      {firstRunNote && <p className="text-xs">{firstRunNote}</p>}

      <p id={willStartId} data-testid="will-start" data-tone={warnStart ? 'warning' : 'neutral'} className={`text-xs ${warnStart ? 'font-semibold' : ''}`}>
        {/* The warning tone is never conveyed by weight alone: a symbol for sight, text for a screen reader. */}
        {warnStart && <span aria-hidden="true">⚠ </span>}
        {warnStart && <span className="sr-only">Warning: </span>}
        Will start: {willStartText(descriptor.displayName, mode, permissionLabel, networkMode)}
      </p>

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
            <button
              type="button"
              className={buttonClass}
              style={buttonStyle}
              onClick={() => void start()}
              // Start is the initial focus only when resolution replaced nothing: one Enter must never start a changed choice.
              data-autofocus={notices.length === 0 ? true : undefined}
              {...props}
              aria-describedby={[props['aria-describedby'], willStartId, sandbox && networkMode === 'open' ? networkWarningId : undefined].filter(Boolean).join(' ')}
            >
              Start
            </button>
          )}
        </DisabledReason>
      </div>
    </div>
  )
}
