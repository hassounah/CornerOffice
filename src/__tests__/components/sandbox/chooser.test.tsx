import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StartSessionChooser } from '../../../renderer/components/sandbox/StartSessionChooser'
import { RecreateDialog } from '../../../renderer/components/sandbox/RecreateDialog'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { useTerminalStore } from '../../../renderer/stores/terminal-store'
import { CLAUDE_DESCRIPTOR } from '@main/agents/claude/descriptor'
import { AGENT_DESCRIPTORS } from '@main/agents/descriptors'
import { builtinChoice } from '../../../renderer/utils/session-options'
import { expectNoAxeViolations } from '../../helpers/a11y'
import type { AgentDescriptor } from '@main/agents/types'
import type { SessionChoice } from '@main/types/config'
import {
  ELIGIBILITY_COPY,
  agentReadinessMessage,
  WARNING_COPY,
  START_FAILURE_COPY,
  RECREATE_FAILURE_COPY,
  SANDBOX_UNAVAILABLE_COPY,
  PORT_CONFLICT_NO_RECREATE_COPY,
  BUILD_CONFIRM_COPY,
  BUILD_FAILED_COPY,
  IMAGE_SIZE_COPY,
  IMAGE_READY_COPY,
  IMAGE_BUILDING_REASON,
  TRUST_PROMPT_COPY,
  CHECKING_COPY,
  forSkin,
  RECREATED_COPY,
  STATUS_CHECK_TIMEOUT_MS,
} from '../../../renderer/utils/sandbox-copy'
import type { SandboxStatus, RecreatePlan, EligibilityReason, EligibilityWarning } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// StartSessionChooser and RecreateDialog — step 5.4 (TRD §3.15.2, §3.16,
// §14.5, UX-C, UX-C2, D10, SEC-H1, B-H2, UX-M1).
// ---------------------------------------------------------------------------

const api = {
  getStatus: vi.fn(),
  getEnvironment: vi.fn(),
  startSession: vi.fn(),
  buildImage: vi.fn(),
  recreate: vi.fn(),
}
const terminalSpawn = vi.fn()
const getDefaults = vi.fn()
const getHostAvailability = vi.fn()
Object.defineProperty(window, 'cornerOffice', {
  value: { sandbox: api, terminal: { spawn: terminalSpawn }, session: { getDefaults }, agents: { getHostAvailability }, on: vi.fn(() => vi.fn()) },
  writable: true,
  configurable: true,
})

const ok = <T,>(data: T) => ({ data, error: null })
const HASH = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)

function plan(overrides: Partial<RecreatePlan> = {}): RecreatePlan {
  return { reason: 'mount-plan', specHash: HASH, newHostMounts: [], removedHostMounts: [], ...overrides }
}

function status(
  opts: {
    reason?: EligibilityReason
    warnings?: EligibilityWarning[]
    state?: SandboxStatus['session']['state']
    plan?: RecreatePlan | null
    /** Per-agent readiness; every agent is ready unless listed. */
    readiness?: NonNullable<SandboxStatus['agentReadiness']>
  } = {},
): SandboxStatus {
  return {
    workspaceSlug: 'ws',
    eligibility: opts.reason ? { ok: false, reason: opts.reason } : { ok: true, baseBranch: 'main', warnings: opts.warnings ?? [] },
    agentReadiness: { claude: null, codex: null, ...opts.readiness },
    exists: false,
    container: 'absent',
    worktree: 'absent',
    session: { state: opts.state ?? 'idle', permissionMode: null, networkMode: null, lastExit: null },
    git: null,
    recreatePending: false,
    recreatePlan: opts.plan ?? null,
    channel: 'none',
  }
}

function setup(s: SandboxStatus = status()): void {
  api.getStatus.mockResolvedValue(ok(s))
  useSandboxStore.setState({ status: { ws: s }, build: { running: false, lines: [], phase: 'idle', requestedFor: null }, environment: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getEnvironment.mockResolvedValue(ok(null))
  api.startSession.mockResolvedValue(ok({ ok: true, workspaceSlug: 'ws', kind: 'sandbox' }))
  api.buildImage.mockResolvedValue(ok({ ok: true }))
  api.recreate.mockResolvedValue(ok({ ok: true }))
  terminalSpawn.mockReset()
  terminalSpawn.mockResolvedValue(ok({ workspaceSlug: 'ws' }))
  getDefaults.mockReset()
  getDefaults.mockResolvedValue(ok({ choice: null, source: 'builtin' }))
  getHostAvailability.mockReset()
  getHostAvailability.mockResolvedValue(ok({ claude: 'found', codex: 'found' }))
  useTerminalStore.setState({ sessions: {}, overlayVisible: {}, spawnError: {}, sessionKind: {}, sessionAgent: {}, lastSpawnOpts: {}, spawnFailure: {}, buildPrompt: {}, recreatePrompt: {} })
  setup()
})

// Most tests exercise one agent, so the Agent row (shown only when several are registered) stays out of the way.
const ONE_AGENT = [CLAUDE_DESCRIPTOR]
// ...and start from a pre-resolved built-in choice, so they don't wait for the open-time resolution (those tests pass `initial: undefined`).
const BUILTIN_INITIAL = { choice: builtinChoice(), source: 'builtin' as const }

function renderChooser(props: Partial<React.ComponentProps<typeof StartSessionChooser>> = {}) {
  const onClose = vi.fn()
  const view = render(<StartSessionChooser slug="ws" agents={ONE_AGENT} initial={BUILTIN_INITIAL} onClose={onClose} {...props} />)
  return { onClose, hostSpawn: terminalSpawn, ...view }
}

const radio = (name: string) => screen.getByRole('radio', { name })

describe('StartSessionChooser — choices', () => {
  it('is a dialog with Host selected, Default permissions and no network row by default', () => {
    renderChooser()
    expect(screen.getByRole('dialog', { name: 'Start a session' })).toBeInTheDocument()
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'false')
    expect(within(screen.getByRole('radiogroup', { name: 'Permissions' })).getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('permission-note')).toHaveTextContent('Uses your Claude Code settings.')
    expect(screen.queryByRole('radiogroup', { name: 'Network' })).toBeNull()
  })

  it('Start on Host starts through the terminal store with the chosen mode and closes, without touching the sandbox', async () => {
    const { hostSpawn, onClose } = renderChooser()
    await userEvent.click(radio('Auto mode'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(hostSpawn).toHaveBeenCalledTimes(1)
    expect(hostSpawn).toHaveBeenCalledWith('ws', 80, 24, expect.objectContaining({ agentId: 'claude', permissionMode: 'auto' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.startSession).not.toHaveBeenCalled()
  })

  it('Cancel and Escape close the chooser', async () => {
    const { onClose } = renderChooser()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('refreshes the status and environment on open', async () => {
    renderChooser()
    await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalledWith('ws'))
    expect(api.getEnvironment).toHaveBeenCalledWith(true)
  })

  it('selecting Sandbox reveals Permissions and Network with Skip permissions and Allowlist as the defaults', async () => {
    renderChooser()
    await userEvent.click(radio('Sandbox'))

    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'true')
    expect(within(screen.getByRole('radiogroup', { name: 'Permissions' })).getByRole('radio', { name: 'Skip permissions' })).toHaveAttribute('aria-checked', 'true')
    expect(within(screen.getByRole('radiogroup', { name: 'Network' })).getByRole('radio', { name: 'Allowlist' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/Unrestricted network:/)).toBeNull()
  })

  it('Unrestricted shows its warning line, and going back to Allowlist hides it', async () => {
    renderChooser()
    await userEvent.click(radio('Sandbox'))

    await userEvent.click(radio('Unrestricted'))
    expect(screen.getByTestId('network-announcer')).toHaveTextContent('Unrestricted network: the sandbox can reach any site on the internet. The firewall is off for this session.')

    await userEvent.click(radio('Allowlist'))
    expect(screen.getByTestId('network-announcer')).toBeEmptyDOMElement()
  })

  it('arrow keys move focus within a group, and the roving tabindex follows the selection', async () => {
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    const skip = radio('Skip permissions')
    const auto = radio('Auto mode')
    skip.focus()

    await userEvent.keyboard('{ArrowRight}')
    expect(auto).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(skip).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(auto).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(auto).toHaveAttribute('aria-checked', 'true')
    expect(auto).toHaveAttribute('tabindex', '0')
    expect(skip).toHaveAttribute('tabindex', '-1')
    await userEvent.keyboard('{ArrowDown}{ArrowUp}')
    expect(auto).toHaveFocus()
  })

  it('other keys do nothing to the focus', async () => {
    renderChooser()
    radio('Host').focus()
    await userEvent.keyboard('a')
    expect(radio('Host')).toHaveFocus()
  })
})

describe('StartSessionChooser — agent, permissions, "Will start" and Reset (B6)', () => {
  const REMEMBERED: { choice: SessionChoice; source: 'workspace' | 'last' } = {
    choice: { agentId: 'claude', location: 'sandbox', hostPermissionMode: 'auto', sandboxPermissionMode: 'auto', networkMode: 'open' },
    source: 'workspace',
  }

  it('hides the Agent row with one agent and shows it with several', () => {
    const { unmount } = renderChooser()
    expect(screen.queryByRole('radiogroup', { name: 'Agent' })).toBeNull()
    unmount()

    renderChooser({ agents: AGENT_DESCRIPTORS })
    const group = screen.getByRole('radiogroup', { name: 'Agent' })
    expect(within(group).getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true')
    expect(within(group).getByRole('radio', { name: 'Codex' })).toBeInTheDocument()
  })

  it('selecting an agent without a sandbox half leaves the sandbox, and explains why Sandbox is unavailable', async () => {
    setup(status())
    renderChooser({ agents: AGENT_DESCRIPTORS, initial: { choice: { ...REMEMBERED.choice }, source: 'last' } })
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(radio('Codex'))

    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(radio('Sandbox'))
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText("Codex isn't available in the sandbox yet.")).toBeInTheDocument()
  })

  it('changing the agent never silently leaves the sandbox: it is announced, reported as a fallback, and Start is not focused', async () => {
    setup(status())
    renderChooser({ agents: AGENT_DESCRIPTORS, initial: { choice: { ...REMEMBERED.choice }, source: 'last' } })

    await userEvent.click(radio('Codex'))

    expect(screen.getByTestId('notices-region')).toHaveTextContent("Codex doesn't run in the sandbox yet, so Host is selected.")
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).not.toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(terminalSpawn).toHaveBeenCalledWith(
      'ws',
      80,
      24,
      expect.objectContaining({ agentId: 'codex', fallbackFields: ['location'] }),
    )
  })

  it('shows the warning tone as a symbol and a screen-reader prefix, not only as weight', async () => {
    renderChooser()
    expect(screen.getByTestId('will-start')).not.toHaveTextContent('Warning:')

    await userEvent.click(radio('Sandbox'))
    const summary = screen.getByTestId('will-start')
    expect(summary).toHaveTextContent('Warning: Will start:')
    expect(summary.querySelector('[aria-hidden="true"]')).toHaveTextContent('⚠')
  })

  it('Start is also described by the Unrestricted warning when it applies', async () => {
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAccessibleDescription(/Will start/)
    await userEvent.click(radio('Unrestricted'))
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAccessibleDescription(/Unrestricted network/)
  })

  it('Reset is named "Reset" and described by its tooltip text', () => {
    renderChooser()
    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toHaveAccessibleDescription('Resets these choices. Nothing is saved until you start.')
  })

  it('takes the permission modes and the selected mode note from the descriptor, per location', async () => {
    renderChooser()
    expect(screen.getByTestId('permission-note')).toHaveTextContent('Uses your Claude Code settings.')
    await userEvent.click(radio('Auto mode'))
    expect(screen.getByTestId('permission-note')).toHaveTextContent('Claude decides when to ask.')

    await userEvent.click(radio('Sandbox'))
    const group = screen.getByRole('radiogroup', { name: 'Permissions' })
    expect(within(group).getByRole('radio', { name: 'Skip permissions' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('permission-note')).toHaveTextContent('Never asks. The sandbox is the boundary.')
  })

  it('renders a single offered mode as a static line, not a radio group', () => {
    const single = {
      ...CLAUDE_DESCRIPTOR,
      permissionModes: { host: [{ mode: 'default', label: 'Default', note: 'Uses your settings.' }], sandbox: CLAUDE_DESCRIPTOR.permissionModes.sandbox },
    } as unknown as AgentDescriptor
    renderChooser({ agents: [single] })

    expect(screen.queryByRole('radiogroup', { name: 'Permissions' })).toBeNull()
    expect(screen.getByTestId('permission-static')).toHaveTextContent('Permissions')
    expect(screen.getByTestId('permission-static')).toHaveTextContent('Default')
    expect(screen.getByTestId('permission-static')).toHaveTextContent('Uses your settings.')
  })

  it('shows the Network row for the sandbox only, and the per-location first-run note', async () => {
    renderChooser()
    expect(screen.queryByRole('radiogroup', { name: 'Network' })).toBeNull()
    expect(screen.queryByText(TRUST_PROMPT_COPY)).toBeNull()

    await userEvent.click(radio('Sandbox'))
    expect(screen.getByRole('radiogroup', { name: 'Network' })).toBeInTheDocument()
    expect(screen.getByText(TRUST_PROMPT_COPY)).toBeInTheDocument()
  })

  it('shows the host first-run note for an agent that has one', () => {
    renderChooser({ agents: AGENT_DESCRIPTORS, initial: { choice: { ...REMEMBERED.choice, agentId: 'codex', location: 'host' }, source: 'last' } })
    expect(screen.getByText(/Codex asks to trust this folder/)).toBeInTheDocument()
  })

  it('"Will start" summarizes the choice, and Start is described by it', async () => {
    renderChooser()
    const summary = screen.getByTestId('will-start')
    expect(summary).toHaveTextContent('Will start: Claude Code · Host · Default')
    expect(screen.getByRole('button', { name: 'Start' }).getAttribute('aria-describedby')).toContain(summary.id)

    await userEvent.click(radio('Sandbox'))
    expect(summary).toHaveTextContent('Will start: Claude Code · Sandbox · Skip permissions · Allowlist')
  })

  it('"Will start" is in warning style for Skip permissions and Unrestricted only', async () => {
    renderChooser()
    const summary = screen.getByTestId('will-start')
    expect(summary).toHaveAttribute('data-tone', 'neutral')

    await userEvent.click(radio('Sandbox'))
    expect(summary).toHaveAttribute('data-tone', 'warning')

    await userEvent.click(radio('Auto mode'))
    expect(summary).toHaveAttribute('data-tone', 'neutral')

    await userEvent.click(radio('Unrestricted'))
    expect(summary).toHaveAttribute('data-tone', 'warning')
    expect(summary).toHaveTextContent('Unrestricted')
  })

  it('Start keeps the Will start description alongside a disabled reason', async () => {
    setup(status({ state: 'ending' }))
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    const describedBy = screen.getByRole('button', { name: 'Start' }).getAttribute('aria-describedby') ?? ''
    expect(describedBy.split(' ')).toHaveLength(2)
    expect(describedBy).toContain(screen.getByTestId('will-start').id)
  })

  it('shows a visible helper label for where the choice came from, with a Reset that explains itself', () => {
    const { unmount } = renderChooser({ initial: REMEMBERED })
    expect(screen.getByTestId('choice-source')).toHaveTextContent('Remembered for this workspace')
    expect(screen.getByRole('button', { name: /^Reset/ })).toHaveAttribute('title', 'Resets these choices. Nothing is saved until you start.')
    unmount()

    renderChooser({ initial: { ...REMEMBERED, source: 'last' } })
    expect(screen.getByTestId('choice-source')).toHaveTextContent('Last used')
  })

  it('starts from the remembered choice', () => {
    renderChooser({ initial: REMEMBERED })
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Unrestricted')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('will-start')).toHaveTextContent('Claude Code · Sandbox · Auto mode · Unrestricted')
  })

  it('Reset returns every row to the built-in choice, clears the label and saves nothing', async () => {
    renderChooser({ initial: REMEMBERED })
    await userEvent.click(screen.getByRole('button', { name: /^Reset/ }))

    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('choice-source')).toBeEmptyDOMElement()
    expect(screen.getByTestId('will-start')).toHaveTextContent('Will start: Claude Code · Host · Default')
    await userEvent.click(radio('Sandbox'))
    expect(screen.getByRole('radio', { name: 'Skip permissions' })).toHaveAttribute('aria-checked', 'true')
    expect(radio('Allowlist')).toHaveAttribute('aria-checked', 'true')
    expect(api.startSession).not.toHaveBeenCalled()
    expect(terminalSpawn).not.toHaveBeenCalled()
  })

  it('a remembered mode the agent no longer offers falls back to its first mode', () => {
    renderChooser({ initial: { choice: { ...REMEMBERED.choice, location: 'host', hostPermissionMode: 'skip' }, source: 'last' } })
    expect(screen.getByTestId('will-start')).toHaveTextContent('Claude Code · Host · Default')
  })
})

describe('StartSessionChooser — Sandbox eligibility (UX-C2)', () => {
  const reasons = Object.keys(ELIGIBILITY_COPY) as EligibilityReason[]

  it.each(reasons)('%s: Sandbox is aria-disabled and explains itself with the eligibility copy', async (reason) => {
    setup(status({ reason }))
    renderChooser()

    const sandbox = radio('Sandbox')
    expect(sandbox).toHaveAttribute('aria-disabled', 'true')
    expect(sandbox).not.toBeDisabled()
    fireEvent.focus(sandbox)
    expect(screen.getByRole('tooltip')).toHaveTextContent(ELIGIBILITY_COPY[reason])

    await userEvent.click(sandbox)
    expect(sandbox).toHaveAttribute('aria-checked', 'false')
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
  })

  it('includes the §14.5 reason, from the agent readiness: "Run Claude Code on this machine once first"', () => {
    setup(status({ readiness: { claude: { code: 'home-missing' } } }))
    renderChooser()
    fireEvent.focus(radio('Sandbox'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Run Claude Code on this machine once first, then try again.')
  })

  it('a malformed ~/.claude is explained the same way, and Sandbox stays unselectable', async () => {
    setup(status({ readiness: { claude: { code: 'config-invalid' } } }))
    renderChooser()
    fireEvent.focus(radio('Sandbox'))
    expect(screen.getByRole('tooltip')).toHaveTextContent(agentReadinessMessage('claude', 'config-invalid') as string)
    await userEvent.click(radio('Sandbox'))
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
  })

  it("another agent's readiness does not disable Sandbox for this one", () => {
    setup(status({ readiness: { codex: { code: 'home-missing' } } }))
    renderChooser()
    fireEvent.focus(radio('Sandbox'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('the workspace being ineligible wins over the agent not being ready', () => {
    setup(status({ reason: 'not-git', readiness: { claude: { code: 'home-missing' } } }))
    renderChooser()
    fireEvent.focus(radio('Sandbox'))
    expect(screen.getByRole('tooltip')).toHaveTextContent(ELIGIBILITY_COPY['not-git'])
  })

  it('a workspace is eligible when only ~/.claude is missing: the workspace reason is not shown', () => {
    setup(status({ readiness: { claude: { code: 'home-missing' } } }))
    renderChooser()
    expect(useSandboxStore.getState().status.ws.eligibility.ok).toBe(true)
  })

  it('an eligible workspace has no tooltip and shows its warnings in the eligibility tone', () => {
    setup(status({ warnings: ['base-not-main', 'docs-root-missing', 'docs-root-untrusted', 'image-stale'] }))
    renderChooser()

    expect(radio('Sandbox')).not.toHaveAttribute('aria-disabled')
    for (const warning of Object.values(WARNING_COPY)) expect(screen.getByText(warning)).toBeInTheDocument()
  })

  it('no warnings are shown for an ineligible workspace, and none when there are none', () => {
    setup(status({ reason: 'not-git' }))
    const { unmount } = renderChooser()
    expect(screen.queryByRole('list')).toBeNull()
    unmount()

    setup(status())
    renderChooser()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('while the status is unknown, Sandbox is not selectable yet', async () => {
    api.getStatus.mockResolvedValue(ok(null))
    useSandboxStore.setState({ status: {} })
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'false')
  })
})

describe('StartSessionChooser — starting a sandbox session', () => {
  async function chooseSandbox(): Promise<void> {
    await userEvent.click(radio('Sandbox'))
  }

  it('Start calls startSession with the chosen modes and closes on success', async () => {
    const { onClose, hostSpawn } = renderChooser()
    await chooseSandbox()
    await userEvent.click(radio('Auto mode'))
    await userEvent.click(radio('Unrestricted'))

    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.startSession).toHaveBeenCalledExactlyOnceWith('ws', 80, 24, 'auto', 'open', expect.objectContaining({ agentId: 'claude' }))
    expect(hostSpawn).not.toHaveBeenCalled()
  })

  it('never calls startSession before Start is pressed', async () => {
    renderChooser()
    await chooseSandbox()
    await userEvent.click(radio('Auto mode'))
    expect(api.startSession).not.toHaveBeenCalled()
  })

  it('Start is aria-disabled with the still-stopping reason during stop-unconfirmed', async () => {
    setup(status({ state: 'stop-unconfirmed' }))
    renderChooser()
    await chooseSandbox()
    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(start)
    expect(api.startSession).not.toHaveBeenCalled()
  })

  it('Start is aria-disabled with a reason while the sandbox is ending, in the sandbox mode only', async () => {
    setup(status({ state: 'ending' }))
    renderChooser()
    expect(screen.getByRole('button', { name: 'Start' })).not.toHaveAttribute('aria-disabled') // Host start is unaffected

    await chooseSandbox()
    // DisabledReason wraps the button once a reason applies, so look it up again.
    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toHaveAttribute('aria-disabled', 'true')
    expect(start).not.toBeDisabled()
    fireEvent.focus(start)
    expect(screen.getByRole('tooltip')).toHaveTextContent('The sandbox is still stopping.')
    await userEvent.click(start)
    expect(api.startSession).not.toHaveBeenCalled()
  })

  it('Start is aria-disabled while the session is starting', async () => {
    renderChooser()
    await chooseSandbox()
    act(() => useTerminalStore.setState({ sessions: { ws: 'starting' } }))
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('shows a start failure in an alert and stays open', async () => {
    api.startSession.mockResolvedValue(ok({ ok: false, code: 'FIREWALL_FAILED', detail: null }))
    const { onClose } = renderChooser()
    await chooseSandbox()

    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(START_FAILURE_COPY.FIREWALL_FAILED as string)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the eligibility reason when the start is refused as NOT_ELIGIBLE', async () => {
    api.startSession.mockResolvedValue(ok({ ok: false, code: 'NOT_ELIGIBLE', detail: null }))
    // Eligible when the chooser opens; the world changes before Start.
    api.getStatus.mockResolvedValueOnce(ok(status()))
    api.getStatus.mockResolvedValue(ok(status({ reason: 'not-git' })))
    renderChooser()
    await chooseSandbox()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(ELIGIBILITY_COPY['not-git'])
  })

  it('shows the agent readiness copy when the start is refused as AGENT_NOT_READY', async () => {
    api.startSession.mockResolvedValue(ok({ ok: false, code: 'AGENT_NOT_READY', detail: null, agentId: 'claude', readiness: 'home-missing' }))
    renderChooser()
    await chooseSandbox()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Run Claude Code on this machine once first, then try again.')
  })

  it('shows the unavailable copy when main is not ready', async () => {
    api.startSession.mockResolvedValue({ data: { data: null, error: { code: 'NOT_READY', message: 'x' } }, error: null })
    renderChooser()
    await chooseSandbox()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)
  })
})

describe.each(['office', 'realm'] as const)('StartSessionChooser — Check again for Docker reasons (UX-H3, skin=%s)', (skin) => {
  const dockerReasons: EligibilityReason[] = ['docker-not-installed', 'docker-daemon-down', 'docker-no-permission', 'docker-unsupported-daemon', 'docker-too-old', 'docker-rootless', 'docker-podman']
  const otherReasons: EligibilityReason[] = ['not-git', 'no-base-branch', 'repo-unsafe']

  it.each(dockerReasons)('%s shows a Check again button', (reason) => {
    setup(status({ reason }))
    renderChooser({ skin })
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it.each(otherReasons)('%s shows no Check again button, and neither does an eligible workspace', (reason) => {
    setup(status({ reason }))
    const { unmount } = renderChooser({ skin })
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    unmount()
    setup(status())
    renderChooser({ skin })
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  })

  it('re-fetches the environment with refresh=true, then the status, and Sandbox becomes selectable once Docker is ok', async () => {
    setup(status({ reason: 'docker-daemon-down' }))
    renderChooser({ skin })
    await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalled())
    api.getStatus.mockClear()
    api.getEnvironment.mockClear()
    api.getStatus.mockResolvedValue(ok(status()))

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))

    expect(api.getEnvironment).toHaveBeenCalledWith(true)
    expect(api.getStatus).toHaveBeenCalledWith('ws')
    expect(api.getEnvironment.mock.invocationCallOrder[0]).toBeLessThan(api.getStatus.mock.invocationCallOrder[0])
    await vi.waitFor(() => expect(radio('Sandbox')).not.toHaveAttribute('aria-disabled'))
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    // Focus lands on the selected option instead of dropping to the page.
    expect(radio('Host')).toHaveFocus()
    await userEvent.click(radio('Sandbox'))
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'true')
  })

  it('stays put, and keeps the button, when Docker is still down', async () => {
    setup(status({ reason: 'docker-daemon-down' }))
    renderChooser({ skin })
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).not.toHaveAttribute('aria-disabled'))
    expect(radio('Sandbox')).toHaveAttribute('aria-disabled', 'true')
  })

  it('a double click makes one fetch, and the button reads as busy meanwhile', async () => {
    setup(status({ reason: 'docker-daemon-down' }))
    renderChooser({ skin })
    await vi.waitFor(() => expect(api.getEnvironment).toHaveBeenCalled())
    api.getEnvironment.mockClear()
    let release: (v: unknown) => void = () => {}
    api.getEnvironment.mockReturnValue(new Promise((resolve) => { release = resolve }))

    const button = screen.getByRole('button', { name: 'Check again' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(api.getEnvironment).toHaveBeenCalledTimes(1)
    const busy = await screen.findByRole('button', { name: 'Checking…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { release(ok(null)) })
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument())
  })
})

describe('StartSessionChooser — trust prompt, Unrestricted announcement and status states (UX-H4)', () => {
  it('says the first session asks for folder trust, in sandbox mode only', async () => {
    renderChooser()
    expect(screen.queryByText(TRUST_PROMPT_COPY)).toBeNull()
    await userEvent.click(radio('Sandbox'))
    expect(screen.getByText(TRUST_PROMPT_COPY)).toBeInTheDocument()
    await userEvent.click(radio('Host'))
    expect(screen.queryByText(TRUST_PROMPT_COPY)).toBeNull()
  })

  it('the Unrestricted warning goes into a live region that already exists before it is toggled', async () => {
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    const announcer = screen.getByTestId('network-announcer')
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    expect(announcer).toBeEmptyDOMElement()
    await userEvent.click(radio('Unrestricted'))
    expect(screen.getByTestId('network-announcer')).toBe(announcer)
    expect(announcer).toHaveTextContent(/Unrestricted network/)
  })

  it('while the status is loading, Sandbox is aria-disabled with "Checking…"', async () => {
    useSandboxStore.setState({ status: {} })
    api.getStatus.mockReturnValue(new Promise(() => {}))
    renderChooser()
    const sandbox = radio('Sandbox')
    expect(sandbox).toHaveAttribute('aria-disabled', 'true')
    fireEvent.focus(sandbox)
    expect(screen.getByRole('tooltip')).toHaveTextContent(CHECKING_COPY)
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  })

  it('a status fetch that never settles leaves "Checking…" after 10 s, with Check again', async () => {
    vi.useFakeTimers()
    try {
      useSandboxStore.setState({ status: {} })
      api.getStatus.mockReturnValue(new Promise(() => {}))
      renderChooser()
      expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()

      await act(async () => { vi.advanceTimersByTime(STATUS_CHECK_TIMEOUT_MS - 1) })
      expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
      await act(async () => { vi.advanceTimersByTime(1) })

      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
      fireEvent.focus(radio('Sandbox'))
      expect(screen.getByRole('tooltip')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)
    } finally {
      vi.useRealTimers()
    }
  })

  it('changing the workspace slug shows "Checking…" again until that workspace settles', async () => {
    vi.useFakeTimers()
    try {
      useSandboxStore.setState({ status: {} })
      api.getStatus.mockReturnValue(new Promise(() => {}))
      const { rerender } = renderChooser()
      await act(async () => { vi.advanceTimersByTime(STATUS_CHECK_TIMEOUT_MS) })
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()

      rerender(<StartSessionChooser slug="other" agents={ONE_AGENT} initial={BUILTIN_INITIAL} onClose={vi.fn()} />)
      expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
      fireEvent.focus(radio('Sandbox'))
      expect(screen.getByRole('tooltip')).toHaveTextContent(CHECKING_COPY)

      await act(async () => { vi.advanceTimersByTime(STATUS_CHECK_TIMEOUT_MS) })
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('when the status fetch failed, Sandbox says so and offers Check again, which recovers', async () => {
    useSandboxStore.setState({ status: {} })
    api.getStatus.mockRejectedValue(new Error('main not ready'))
    renderChooser()

    const retry = await screen.findByRole('button', { name: 'Check again' })
    fireEvent.focus(radio('Sandbox'))
    expect(screen.getByRole('tooltip')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)

    api.getStatus.mockResolvedValue(ok(status()))
    await userEvent.click(retry)
    await vi.waitFor(() => expect(radio('Sandbox')).not.toHaveAttribute('aria-disabled'))
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(radio('Host')).toHaveFocus()
  })

  it('a failed check does not leave focus armed: Docker coming back later does not steal it', async () => {
    setup(status({ reason: 'docker-daemon-down' }))
    renderChooser()
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).not.toHaveAttribute('aria-disabled'))

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    act(() => useSandboxStore.setState({ status: { ws: status() } }))
    expect(radio('Sandbox')).not.toHaveAttribute('aria-disabled')
    expect(cancel).toHaveFocus()
  })
})

describe('StartSessionChooser — build flow (UX-C)', () => {
  async function startIntoMissingImage(modes: { auto?: boolean; open?: boolean } = {}) {
    api.startSession.mockResolvedValue(ok({ ok: false, code: 'IMAGE_MISSING', detail: null }))
    const view = renderChooser({ onShowLog: vi.fn() })
    await userEvent.click(radio('Sandbox'))
    if (modes.auto) await userEvent.click(radio('Auto mode'))
    if (modes.open) await userEvent.click(radio('Unrestricted'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByText('Build the sandbox image?')
    return view
  }

  it('IMAGE_MISSING asks to build, with size, time and "you press Start", after exactly one startSession call', async () => {
    await startIntoMissingImage()
    expect(screen.getByText(/About 1\.4 GB, takes several minutes\. The session won't start by itself: you'll press Start when the image is ready\./)).toBeInTheDocument()
    expect(api.startSession).toHaveBeenCalledTimes(1)
    expect(api.buildImage).not.toHaveBeenCalled()
  })

  it('Cancel on the confirm builds nothing and returns to the chooser', async () => {
    await startIntoMissingImage()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('radiogroup', { name: 'Where' })).toBeInTheDocument()
    expect(api.buildImage).not.toHaveBeenCalled()
  })

  it('Build starts the build (not a rebuild), shows progress with Show log, and calls no further startSession', async () => {
    let finish: (v: unknown) => void = () => {}
    api.buildImage.mockReturnValue(new Promise((r) => { finish = r }))
    const { rerender } = await startIntoMissingImage()
    const onShowLog = vi.fn()
    rerender(<StartSessionChooser slug="ws" agents={ONE_AGENT} onClose={vi.fn()} onShowLog={onShowLog} />)

    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    expect(api.buildImage).toHaveBeenCalledWith(false, 'ws')
    act(() => useSandboxStore.setState((s) => ({ build: { ...s.build, lines: ['Step 3/9'] } })))

    expect(screen.getByRole('status')).toHaveTextContent('Building the image… Step 3/9')
    await userEvent.click(screen.getByRole('button', { name: 'Show log' }))
    expect(onShowLog).toHaveBeenCalledTimes(1)
    expect(api.startSession).toHaveBeenCalledTimes(1)

    finish(ok({ ok: true }))
  })

  it('omits the Show log link when there is nowhere to show it', async () => {
    api.buildImage.mockReturnValue(new Promise(() => {}))
    api.startSession.mockResolvedValue(ok({ ok: false, code: 'IMAGE_MISSING', detail: null }))
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Build' }))
    expect(screen.queryByRole('button', { name: 'Show log' })).toBeNull()
  })

  it('after the build: "Image ready", the same toggles, and ZERO further startSession calls until Start is clicked', async () => {
    await startIntoMissingImage({ auto: true, open: true })
    await userEvent.click(screen.getByRole('button', { name: 'Build' }))

    // buildImage resolved: the store marks the build done for this workspace.
    await vi.waitFor(() => expect(useSandboxStore.getState().build.phase).toBe('done'))
    expect(await screen.findByText(/Image ready/)).toBeInTheDocument()
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Auto mode')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Unrestricted')).toHaveAttribute('aria-checked', 'true')
    expect(api.startSession).toHaveBeenCalledTimes(1)

    api.startSession.mockResolvedValue(ok({ ok: true, workspaceSlug: 'ws', kind: 'sandbox' }))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(2))
    expect(api.startSession).toHaveBeenLastCalledWith('ws', 80, 24, 'auto', 'open', expect.objectContaining({ agentId: 'claude' }))
    await vi.waitFor(() => expect(screen.queryByText(/Image ready/)).toBeNull())
  })

  it('a build for another workspace is not shown here', async () => {
    useSandboxStore.setState({ build: { running: true, lines: ['x'], phase: 'running', requestedFor: { slug: 'other', permissionMode: 'skip', networkMode: 'allowlist' } } })
    renderChooser()
    expect(screen.queryByText(/Building the image/)).toBeNull()
  })

  it('a failed or cancelled build says so and Start builds again', async () => {
    api.buildImage.mockResolvedValue(ok({ ok: false, cancelled: false, detail: 'x' }))
    await startIntoMissingImage()
    await userEvent.click(screen.getByRole('button', { name: 'Build' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The image build did not finish. Start again to build it.')
  })

  it('a build call that throws is reported the same way', async () => {
    api.buildImage.mockResolvedValue({ data: { data: null, error: { code: 'NOT_READY', message: 'x' } }, error: null })
    await startIntoMissingImage()
    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The image build did not finish.')
  })
})

describe('StartSessionChooser — recreate flows', () => {
  it('RECREATE_REQUIRED opens the recreate dialog with the plan; confirming recreates, then Start is explicit', async () => {
    const needed = plan({ reason: 'mount-plan', newHostMounts: [{ path: '/work/docs', readonly: false, source: 'settings' }] })
    api.startSession.mockResolvedValueOnce(ok({ ok: false, code: 'RECREATE_REQUIRED', detail: null }))
    api.getStatus.mockResolvedValue(ok(status({ plan: needed })))
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('/work/docs')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Recreate' }))

    expect(api.recreate).toHaveBeenCalledWith('ws', false, HASH)
    expect(await screen.findByText(RECREATED_COPY)).toBeInTheDocument()
    expect(api.startSession).toHaveBeenCalledTimes(1)
  })

  it('Cancel on the recreate dialog changes nothing and starts nothing', async () => {
    api.startSession.mockResolvedValueOnce(ok({ ok: false, code: 'RECREATE_REQUIRED', detail: null }))
    api.getStatus.mockResolvedValue(ok(status({ plan: plan() })))
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.recreate).not.toHaveBeenCalled()
    expect(api.startSession).toHaveBeenCalledTimes(1)
  })

  it('PORT_CONFLICT shows its copy and an explicit "Recreate with a new port", confirmed through the dialog', async () => {
    api.startSession.mockResolvedValueOnce(ok({ ok: false, code: 'PORT_CONFLICT', detail: null }))
    api.getStatus.mockResolvedValue(ok(status({ plan: plan({ reason: 'port' }) })))
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(START_FAILURE_COPY.PORT_CONFLICT as string)
    await userEvent.click(within(alert).getByRole('button', { name: 'Recreate with a new port' }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent("The sandbox's channel port changed.")
    await userEvent.click(within(dialog).getByRole('button', { name: 'Recreate' }))

    expect(api.recreate).toHaveBeenCalledWith('ws', true, HASH)
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByText(RECREATED_COPY)).toBeInTheDocument()
    expect(screen.queryByText(START_FAILURE_COPY.PORT_CONFLICT as string)).toBeNull()
  })

  it('PORT_CONFLICT without a port plan offers no recreate button (nothing to confirm)', async () => {
    api.startSession.mockResolvedValueOnce(ok({ ok: false, code: 'PORT_CONFLICT', detail: null }))
    api.getStatus.mockResolvedValue(ok(status()))
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Recreate with a new port' })).toBeNull()
  })

  it('cancelling the port recreate closes only the dialog', async () => {
    api.startSession.mockResolvedValueOnce(ok({ ok: false, code: 'PORT_CONFLICT', detail: null }))
    api.getStatus.mockResolvedValue(ok(status({ plan: plan({ reason: 'port' }) })))
    renderChooser()
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Recreate with a new port' }))

    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.recreate).not.toHaveBeenCalled()
  })
})

describe('StartSessionChooser — focus and skins', () => {
  it('returns focus to the control that opened it', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    const { unmount } = renderChooser({ returnFocusRef: { current: opener } })

    unmount()

    expect(opener).toHaveFocus()
    opener.remove()
  })

  describe.each(['office', 'realm'] as const)('focus after a start (skin=%s)', (skin) => {
    afterEach(() => {
      document.querySelectorAll('[data-terminal-overlay]').forEach((el) => el.remove())
    })

    function addOverlay(): HTMLElement {
      const overlay = document.createElement('div')
      overlay.setAttribute('data-terminal-overlay', 'ws')
      overlay.tabIndex = -1
      document.body.appendChild(overlay)
      return overlay
    }

    it('a successful sandbox start moves focus to the terminal, not to the Start button that is going away', async () => {
      const opener = document.createElement('button')
      document.body.appendChild(opener)
      const overlay = addOverlay()
      useTerminalStore.setState({ sessions: { ws: 'running' } })
      const { unmount } = renderChooser({ skin, returnFocusRef: { current: opener } })
      await userEvent.click(radio('Sandbox'))
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      await vi.waitFor(() => expect(overlay).toHaveFocus())
      unmount()
      expect(overlay).toHaveFocus()
      opener.remove()
      overlay.remove()
    })

    it('leaves focus alone when something inside the terminal already has it', async () => {
      const overlay = addOverlay()
      const input = document.createElement('textarea')
      overlay.appendChild(input)
      // The terminal takes its own focus as the session starts, before the chooser looks.
      terminalSpawn.mockImplementation(async () => {
        input.focus()
        return ok({ workspaceSlug: 'ws' })
      })
      renderChooser({ skin })
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalled())
      expect(input).toHaveFocus()
      expect(overlay).not.toHaveFocus()
    })

    it('prefers the xterm input inside the overlay over the container', async () => {
      const overlay = addOverlay()
      const xterm = document.createElement('textarea')
      xterm.className = 'xterm-helper-textarea'
      overlay.appendChild(xterm)
      renderChooser({ skin })
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      await vi.waitFor(() => expect(xterm).toHaveFocus())
    })

    it('a host start moves focus to the terminal too', async () => {
      const overlay = addOverlay()
      const { unmount } = renderChooser({ skin })
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      await vi.waitFor(() => expect(overlay).toHaveFocus())
      unmount()
      expect(overlay).toHaveFocus()
      overlay.remove()
    })

    it('finds a terminal overlay that mounts a tick later', async () => {
      let overlay: HTMLElement | null = null
      // The host spawn mounts the overlay on the next tick, after the chooser first looked for it.
      terminalSpawn.mockImplementation(async () => {
        setTimeout(() => {
          overlay = addOverlay()
        }, 0)
        return ok({ workspaceSlug: 'ws' })
      })
      const { unmount } = renderChooser({ skin })
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      await vi.waitFor(() => expect(overlay).not.toBeNull())
      await vi.waitFor(() => expect(overlay).toHaveFocus())
      unmount()
      ;(overlay as HTMLElement | null)?.remove()
    })

    it('a failed start keeps the chooser and does not touch focus; cancelling still returns it to the opener', async () => {
      api.startSession.mockResolvedValue(ok({ ok: false, code: 'SPAWN_FAILED', detail: null }))
      const opener = document.createElement('button')
      document.body.appendChild(opener)
      const overlay = addOverlay()
      const { unmount } = renderChooser({ skin, returnFocusRef: { current: opener } })
      await userEvent.click(radio('Sandbox'))
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      await screen.findByRole('alert')
      expect(overlay).not.toHaveFocus()
      unmount()
      expect(opener).toHaveFocus()
      opener.remove()
      overlay.remove()
    })

    it('does not focus an opener that is no longer in the page', () => {
      const opener = document.createElement('button')
      const focus = vi.spyOn(opener, 'focus')
      const { unmount } = renderChooser({ skin, returnFocusRef: { current: opener } })
      unmount()
      expect(focus).not.toHaveBeenCalled()
    })
  })

  it('renders the same copy and behaviour in the realm skin', async () => {
    setup(status({ warnings: ['image-stale'] }))
    renderChooser({ skin: 'realm' })
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(radio('Unrestricted'))
    expect(screen.getByText(forSkin(WARNING_COPY['image-stale'], 'realm'))).toBeInTheDocument()
    expect(screen.getByText(/Rebuild it in The Armory/)).toBeInTheDocument()
    expect(screen.getByTestId('network-announcer')).toHaveTextContent(/Unrestricted network/)
    expect(radio('Skip permissions')).toBeInTheDocument()
  })

  it('realm skin: ineligible Sandbox is explained, and the build confirm renders', async () => {
    setup(status({ reason: 'not-git' }))
    const { unmount } = renderChooser({ skin: 'realm' })
    fireEvent.focus(radio('Sandbox'))
    expect(screen.getByRole('tooltip')).toHaveTextContent(ELIGIBILITY_COPY['not-git'])
    unmount()

    setup()
    act(() => useTerminalStore.setState({ buildPrompt: { ws: { kind: 'sandbox', permissionMode: 'skip', networkMode: 'allowlist' } } }))
    renderChooser({ skin: 'realm' })
    expect(screen.getByText('Build the sandbox image?')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// RecreateDialog
// ---------------------------------------------------------------------------

describe('RecreateDialog', () => {
  function renderDialog(p: RecreatePlan, extra: Partial<React.ComponentProps<typeof RecreateDialog>> = {}) {
    const onRecreated = vi.fn()
    const onCancel = vi.fn()
    const view = render(<RecreateDialog slug="ws" plan={p} onRecreated={onRecreated} onCancel={onCancel} {...extra} />)
    return { onRecreated, onCancel, ...view }
  }
  const rw = (path: string, source: 'settings' | 'memory.md' | 'app' = 'settings') => ({ path, readonly: false, source })
  const ro = (path: string, source: 'settings' | 'memory.md' | 'app' = 'app') => ({ path, readonly: true, source })

  it.each([
    ['image', 'The sandbox image changed.'],
    ['mount-plan', 'The folders shared with the sandbox changed.'],
    ['port', "The sandbox's channel port changed."],
    ['new-container', "This sandbox doesn't exist yet. Nothing will be removed."],
  ] as const)('shows one reason line for %s', (reason, line) => {
    renderDialog(plan({ reason }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(line)
  })

  it('a plan with only an added read-only overlay says "Only read-only protections were added" and lists no path', () => {
    renderDialog(plan({ newHostMounts: [ro('/repo/.git/index')] }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Only read-only protections were added.')
    expect(dialog).not.toHaveTextContent('/repo/.git/index')
    expect(dialog).not.toHaveTextContent('able to write')
  })

  it('lists every new read-write mount with its full path and source, and ignores read-only ones', () => {
    renderDialog(plan({ newHostMounts: [ro('/ro/overlay'), rw('/home/u/docs', 'settings'), rw('/home/u/other')] }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('The sandbox will be able to write to these folders on your computer:')
    expect(dialog).toHaveTextContent('/home/u/docs')
    expect(dialog).toHaveTextContent('Source: Settings')
    expect(dialog).toHaveTextContent('/home/u/other')
    expect(dialog).not.toHaveTextContent('/ro/overlay')
    expect(dialog).not.toHaveTextContent('Only read-only protections were added.')
  })

  it('adds the memory.md warning for a memory.md-sourced mount, and only for that one (SEC-H1)', () => {
    renderDialog(plan({ newHostMounts: [rw('/home/u/from-memory', 'memory.md'), rw('/home/u/from-settings', 'settings')] }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Source: .rix/memory.md')
    const warnings = within(dialog).getAllByText('This path came from .rix/memory.md, which the sandbox agent can edit. Only continue if you set it yourself.')
    expect(warnings).toHaveLength(1)
  })

  it('a recreate that adds a memory.md folder shows the louder "changed since you approved" warning; a new container does not (#0035)', () => {
    const changed = 'A folder set in .rix/memory.md has changed since you last approved this sandbox.'
    const { unmount } = renderDialog(plan({ newHostMounts: [rw('/home/u/new-docs', 'memory.md')] }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(changed)
    unmount()
    renderDialog(plan({ reason: 'new-container', newHostMounts: [rw('/home/u/docs', 'memory.md')] }))
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(changed)
  })

  it('renders an invisible-character path visibly (review-safe)', () => {
    renderDialog(plan({ newHostMounts: [rw('/home/u/evil‮docs')] }))
    expect(screen.getByRole('alertdialog').textContent).not.toContain('‮')
  })

  it('shows removed mounts and the cache-reset line for a recreate', () => {
    renderDialog(plan({ reason: 'image', removedHostMounts: ['/old/docs'] }))

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('No longer shared with the sandbox:')
    expect(dialog).toHaveTextContent('/old/docs')
    expect(dialog).toHaveTextContent('Container caches will be reset.')
    expect(screen.getByRole('heading')).toHaveTextContent('Recreate the sandbox?')
  })

  it('a new-container plan reads "Create", shows its copy, no removed section and no cache-reset line', () => {
    renderDialog(plan({ reason: 'new-container', newHostMounts: [rw('/home/u/docs', 'memory.md')], removedHostMounts: ['/should/not/show'] }))

    const dialog = screen.getByRole('alertdialog')
    expect(screen.getByRole('heading')).toHaveTextContent('Create the sandbox?')
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeInTheDocument()
    expect(dialog).not.toHaveTextContent('No longer shared')
    expect(dialog).not.toHaveTextContent('/should/not/show')
    expect(dialog).not.toHaveTextContent('Container caches will be reset.')
    expect(dialog).toHaveTextContent('Source: .rix/memory.md')
  })

  it('focuses Cancel first (the safe default), and Tab stays inside the two buttons', async () => {
    renderDialog(plan())
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Recreate' })
    expect(cancel).toHaveFocus()

    await userEvent.tab()
    expect(confirm).toHaveFocus()
    await userEvent.tab()
    expect(cancel).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(confirm).toHaveFocus()
  })

  it('Cancel and Escape change nothing: no recreate call, onCancel fires', async () => {
    const { onCancel } = renderDialog(plan())
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(api.recreate).not.toHaveBeenCalled()
  })

  it('Confirm calls recreate with the plan hash, and reports success without starting anything', async () => {
    const { onRecreated } = renderDialog(plan({ specHash: HASH }))

    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))

    expect(api.recreate).toHaveBeenCalledExactlyOnceWith('ws', false, HASH)
    await vi.waitFor(() => expect(onRecreated).toHaveBeenCalledTimes(1))
    expect(api.startSession).not.toHaveBeenCalled()
  })

  it('passes newPort through', async () => {
    renderDialog(plan({ reason: 'port' }), { newPort: true })
    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))
    expect(api.recreate).toHaveBeenCalledWith('ws', true, HASH)
  })

  it('PLAN_CHANGED reopens with the new plan and the §3.15.3 line, and the next confirm uses the NEW hash', async () => {
    api.recreate.mockResolvedValueOnce(ok({ ok: false, code: 'PLAN_CHANGED' }))
    api.getStatus.mockResolvedValue(ok(status({ plan: plan({ specHash: HASH2, newHostMounts: [rw('/home/u/new-docs', 'memory.md')] }) })))
    const { onRecreated } = renderDialog(plan({ specHash: HASH }))

    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))

    expect(await screen.findByRole('status')).toHaveTextContent('The sandbox settings changed again. Review them before recreating.')
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('/home/u/new-docs')
    expect(onRecreated).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))
    expect(api.recreate).toHaveBeenLastCalledWith('ws', false, HASH2)
    await vi.waitFor(() => expect(onRecreated).toHaveBeenCalled())
  })

  it('PLAN_CHANGED moves focus to Cancel so Enter cannot confirm the new plan unread', async () => {
    api.recreate.mockResolvedValueOnce(ok({ ok: false, code: 'PLAN_CHANGED' }))
    api.getStatus.mockResolvedValue(ok(status({ plan: plan({ specHash: HASH2 }) })))
    renderDialog(plan({ specHash: HASH }))

    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))
    await screen.findByRole('status')

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('PLAN_CHANGED with no fresh plan to show reports the line as an error', async () => {
    api.recreate.mockResolvedValueOnce(ok({ ok: false, code: 'PLAN_CHANGED' }))
    api.getStatus.mockResolvedValue(ok(status()))
    renderDialog(plan())

    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(RECREATE_FAILURE_COPY.PLAN_CHANGED)
  })

  it.each([
    ['SESSION_RUNNING', RECREATE_FAILURE_COPY.SESSION_RUNNING],
    ['FAILED', RECREATE_FAILURE_COPY.FAILED],
  ] as const)('%s shows its fixed copy and stays open', async (code, copy) => {
    api.recreate.mockResolvedValueOnce(ok({ ok: false, code }))
    const { onRecreated } = renderDialog(plan())

    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy)
    expect(onRecreated).not.toHaveBeenCalled()
  })

  it('shows the unavailable copy when main is not reachable', async () => {
    api.recreate.mockResolvedValueOnce({ data: { data: null, error: { code: 'NOT_READY', message: 'x' } }, error: null })
    renderDialog(plan())
    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)
  })

  it('ignores a second click while the recreate is in flight (aria-disabled with a reason)', async () => {
    let finish: (v: unknown) => void = () => {}
    api.recreate.mockReturnValue(new Promise((r) => { finish = r }))
    renderDialog(plan())

    await userEvent.click(screen.getByRole('button', { name: 'Recreate' }))
    const confirm = screen.getByRole('button', { name: 'Recreate' }) // re-queried: DisabledReason wraps it while busy
    await userEvent.click(confirm)

    expect(api.recreate).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).not.toBeDisabled()
    finish(ok({ ok: true }))
  })

  it('renders in the realm skin with the same copy', () => {
    renderDialog(plan({ reason: 'new-container', newHostMounts: [rw('/home/u/docs', 'memory.md')] }), { skin: 'realm' })
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Create the sandbox?')
    expect(dialog).toHaveTextContent(".rix/memory.md, which the sandbox agent can edit")
  })
})

describe('StartSessionChooser — dialog behaviour (5.4 UX fix)', () => {
  const missingImage = () => api.startSession.mockResolvedValue(ok({ ok: false, code: 'IMAGE_MISSING', detail: null }))

  async function startIntoMissingImage(props: Partial<React.ComponentProps<typeof StartSessionChooser>> = {}) {
    missingImage()
    const view = renderChooser(props)
    await userEvent.click(radio('Sandbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByText('Build the sandbox image?')
    return view
  }

  describe('copy and errors', () => {
    it('never echoes raw detail from a failed start', async () => {
      api.startSession.mockResolvedValue(ok({ ok: false, code: 'CONTAINER_FAILED', detail: 'SECRET_PATH /home/x' }))
      renderChooser()
      await userEvent.click(radio('Sandbox'))
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(START_FAILURE_COPY.CONTAINER_FAILED as string)
      expect(document.body).not.toHaveTextContent('SECRET_PATH')
    })

    it('PORT_CONFLICT without a recreate plan says what to do instead of asking a question with no button', async () => {
      api.startSession.mockResolvedValueOnce(ok({ ok: false, code: 'PORT_CONFLICT', detail: null }))
      renderChooser()
      await userEvent.click(radio('Sandbox'))
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(PORT_CONFLICT_NO_RECREATE_COPY)
      expect(alert).not.toHaveTextContent('Recreate the sandbox with a new port?')
      expect(screen.queryByRole('button', { name: 'Recreate with a new port' })).toBeNull()
    })

    it('the build confirm and the ready line use the shared copy', async () => {
      await startIntoMissingImage()
      expect(screen.getByText(BUILD_CONFIRM_COPY)).toBeInTheDocument()
      expect(BUILD_CONFIRM_COPY.startsWith(IMAGE_SIZE_COPY)).toBe(true)
    })
  })

  describe('in-flight guards', () => {
    it('a double click on a sandbox Start spawns once', async () => {
      api.startSession.mockReturnValue(new Promise(() => {}))
      renderChooser()
      await userEvent.click(radio('Sandbox'))
      const start = screen.getByRole('button', { name: 'Start' })
      fireEvent.click(start)
      fireEvent.click(start)
      expect(api.startSession).toHaveBeenCalledTimes(1)
    })

    it('a double click on the Host Start starts the host once', () => {
      const { hostSpawn } = renderChooser()
      const start = screen.getByRole('button', { name: 'Start' })
      fireEvent.click(start)
      fireEvent.click(start)
      expect(hostSpawn).toHaveBeenCalledTimes(1)
    })

    it('a double click on Build starts one build', async () => {
      api.buildImage.mockReturnValue(new Promise(() => {}))
      await startIntoMissingImage()
      const build = screen.getByRole('button', { name: 'Build' })
      fireEvent.click(build)
      fireEvent.click(build)
      expect(api.buildImage).toHaveBeenCalledTimes(1)
    })

    it('Start is aria-disabled with a reason while a build runs, and starts nothing', async () => {
      api.buildImage.mockReturnValue(new Promise(() => {}))
      await startIntoMissingImage()
      await userEvent.click(screen.getByRole('button', { name: 'Build' }))
      expect(api.startSession).toHaveBeenCalledTimes(1)

      const start = screen.getByRole('button', { name: 'Start' })
      expect(start).toHaveAttribute('aria-disabled', 'true')
      fireEvent.focus(start)
      expect(screen.getByRole('tooltip')).toHaveTextContent(IMAGE_BUILDING_REASON)
      await userEvent.click(start)
      expect(api.startSession).toHaveBeenCalledTimes(1)
      expect(api.buildImage).toHaveBeenCalledTimes(1)
    })
  })

  describe('focus', () => {
    it('focuses Start on open when nothing was replaced', () => {
      renderChooser()
      expect(screen.getByRole('button', { name: 'Start' })).toHaveFocus()
    })

    it('focuses Cancel when the panel swaps to the build confirm', async () => {
      await startIntoMissingImage()
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    })

    it('puts focus back on Start when the build confirm is cancelled', async () => {
      await startIntoMissingImage()
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: 'Start' })).toHaveFocus()
    })

    it('hands focus to the recreate dialog, and takes it back when that closes', async () => {
      useTerminalStore.setState({ recreatePrompt: { ws: { plan: plan() } } } as never)
      renderChooser()
      const dialog = screen.getByRole('alertdialog')
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: 'Start' })).toHaveFocus()
    })

    it('is a modal dialog and traps Tab in both directions', () => {
      renderChooser()
      expect(screen.getByRole('dialog', { name: 'Start a session' })).toHaveAttribute('aria-modal', 'true')

      const start = screen.getByRole('button', { name: 'Start' })
      start.focus()
      fireEvent.keyDown(start, { key: 'Tab' })
      // Reset sits in the header row, so it is the first tab stop.
      const reset = screen.getByRole('button', { name: /^Reset/ })
      expect(reset).toHaveFocus()

      fireEvent.keyDown(reset, { key: 'Tab', shiftKey: true })
      expect(screen.getByRole('button', { name: 'Start' })).toHaveFocus()
    })

    it('leaves Tab alone in the middle of the dialog', () => {
      renderChooser()
      const cancel = screen.getByRole('button', { name: 'Cancel' })
      cancel.focus()
      const notPrevented = fireEvent.keyDown(cancel, { key: 'Tab' })
      expect(notPrevented).toBe(true)
    })

    it('returns focus to the real opener on Escape', async () => {
      const opener = document.createElement('button')
      document.body.appendChild(opener)
      const onClose = vi.fn()
      const { unmount } = renderChooser({ returnFocusRef: { current: opener }, onClose })
      fireEvent.keyDown(radio('Host'), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      unmount()
      expect(opener).toHaveFocus()
      opener.remove()
    })
  })

  describe('Escape', () => {
    it('closes from inside the dialog and clears the prompts and the spawn error', () => {
      useTerminalStore.setState({
        buildPrompt: { ws: { kind: 'sandbox', permissionMode: 'skip', networkMode: 'allowlist' } },
        spawnError: { ws: 'Something failed' },
      } as never)
      const { onClose } = renderChooser()
      fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(useTerminalStore.getState().buildPrompt.ws).toBeNull()
      expect(useTerminalStore.getState().spawnError.ws).toBeNull()
    })

    it('does not listen outside the dialog', () => {
      const { onClose } = renderChooser()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
    })

    it('Escape in the recreate dialog closes only that dialog', async () => {
      useTerminalStore.setState({ recreatePrompt: { ws: { plan: plan() } } } as never)
      const { onClose } = renderChooser()
      fireEvent.keyDown(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      expect(useTerminalStore.getState().recreatePrompt.ws).toBeNull()
    })

    it('Escape with a Start tooltip open hides the tooltip first, and the next Escape closes', async () => {
      setup(status({ state: 'ending' }))
      const { onClose } = renderChooser()
      await userEvent.click(radio('Sandbox'))
      const start = screen.getByRole('button', { name: 'Start' })
      fireEvent.focus(start)
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      fireEvent.keyDown(start, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())

      fireEvent.keyDown(start, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Escape in a nested port-recreate dialog closes only that dialog', async () => {
      api.startSession.mockResolvedValueOnce(ok({ ok: false, code: 'PORT_CONFLICT', detail: null }))
      api.getStatus.mockResolvedValue(ok(status({ plan: plan({ reason: 'port' }) })))
      const { onClose } = renderChooser()
      await userEvent.click(radio('Sandbox'))
      await userEvent.click(screen.getByRole('button', { name: 'Start' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Recreate with a new port' }))

      fireEvent.keyDown(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  describe('no stale state on reopen', () => {
    it('does not replay "Image ready" after a build finished and the chooser was reopened', async () => {
      await startIntoMissingImage()
      await userEvent.click(screen.getByRole('button', { name: 'Build' }))
      expect(await screen.findByText(IMAGE_READY_COPY)).toBeInTheDocument()

      cleanup()
      renderChooser()

      expect(screen.queryByText(IMAGE_READY_COPY)).toBeNull()
      expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
      expect(useSandboxStore.getState().build.requestedFor).toBeNull()
    })

    it('does not replay a failed build on a later open', async () => {
      api.buildImage.mockResolvedValue(ok({ ok: false, cancelled: false, detail: null }))
      await startIntoMissingImage()
      await userEvent.click(screen.getByRole('button', { name: 'Build' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(BUILD_FAILED_COPY)

      cleanup()
      renderChooser()

      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('keeps the Settings build log and phase when the request is released', async () => {
      useSandboxStore.setState({ build: { running: false, lines: ['a', 'b'], phase: 'done', requestedFor: { slug: 'ws', permissionMode: 'skip', networkMode: 'allowlist' } } })
      renderChooser()
      const { build } = useSandboxStore.getState()
      expect(build.requestedFor).toBeNull()
      expect(build.lines).toEqual(['a', 'b'])
      expect(build.phase).toBe('done')
    })

    it('still shows a build that is running when the chooser opens', () => {
      useSandboxStore.setState({ build: { running: true, lines: ['Step 1'], phase: 'running', requestedFor: { slug: 'ws', permissionMode: 'skip', networkMode: 'allowlist' } } })
      renderChooser()
      expect(screen.getByRole('status')).toHaveTextContent('Building the image… Step 1')
    })

    it('clears a pending build prompt and spawn error when the chooser goes away', async () => {
      useTerminalStore.setState({
        buildPrompt: { ws: { kind: 'sandbox', permissionMode: 'skip', networkMode: 'allowlist' } },
        spawnError: { ws: 'Something failed' },
      } as never)
      const { unmount } = renderChooser()
      unmount()
      expect(useTerminalStore.getState().buildPrompt.ws).toBeNull()
      expect(useTerminalStore.getState().spawnError.ws).toBeNull()
    })
  })
})

// ── B7: resolve before render, notices, focus, Check again, axe ───────────────

describe.each(['office', 'realm'] as const)('StartSessionChooser — open-time resolution (B7, skin=%s)', (skin) => {
  const REMEMBERED_SANDBOX: SessionChoice = {
    agentId: 'claude',
    location: 'sandbox',
    hostPermissionMode: 'default',
    sandboxPermissionMode: 'auto',
    networkMode: 'open',
  }

  function remember(choice: SessionChoice | null, source: 'workspace' | 'last' = 'workspace'): void {
    getDefaults.mockResolvedValue(ok({ choice, source: choice ? source : 'builtin' }))
  }

  /** Opens the chooser the way the app does: no pre-resolved choice, status only from the (mocked) IPC. */
  function open(s: SandboxStatus | null = status(), props: Partial<React.ComponentProps<typeof StartSessionChooser>> = {}) {
    useSandboxStore.setState({ status: {}, environment: null })
    if (s) api.getStatus.mockResolvedValue(ok(s))
    else api.getStatus.mockReturnValue(new Promise(() => {}))
    const onClose = vi.fn()
    const view = render(<StartSessionChooser slug="ws" skin={skin} agents={ONE_AGENT} onClose={onClose} {...props} />)
    return { onClose, ...view }
  }

  const startButton = () => screen.getByRole('button', { name: 'Start' })

  it('shows a skeleton and an empty live region until the fetch settles, then the form', async () => {
    open(null)

    expect(screen.getByTestId('chooser-skeleton')).toHaveTextContent(CHECKING_COPY)
    expect(screen.getByTestId('notices-region')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByTestId('notices-region')).toBeEmptyDOMElement()
    expect(screen.queryByRole('radio', { name: 'Host' })).toBeNull()
  })

  it('keeps the same live region node when the form replaces the skeleton', async () => {
    let settle: (v: unknown) => void = () => {}
    api.getStatus.mockReturnValue(new Promise((resolve) => { settle = resolve }))
    useSandboxStore.setState({ status: {}, environment: null })
    render(<StartSessionChooser slug="ws" skin={skin} agents={ONE_AGENT} onClose={vi.fn()} />)
    const region = screen.getByTestId('notices-region')

    settle(ok(status()))
    await screen.findByRole('radio', { name: 'Host' })

    expect(screen.getByTestId('notices-region')).toBe(region)
  })

  it('fetches status, a fresh environment and the remembered options together on every open', async () => {
    open()
    await screen.findByRole('radio', { name: 'Host' })
    expect(api.getStatus).toHaveBeenCalledWith('ws')
    expect(api.getEnvironment).toHaveBeenCalledWith(true)
    expect(getDefaults).toHaveBeenCalledWith('ws')
  })

  it('with nothing replaced, Start is the initial focus and there is no banner', async () => {
    open()
    await screen.findByRole('radio', { name: 'Host' })
    // Focus moves in a passive effect after the form mounts.
    await vi.waitFor(() => expect(startButton()).toHaveFocus())
    expect(screen.queryByTestId('notices')).toBeNull()
    expect(screen.getByTestId('notices-region')).toBeEmptyDOMElement()
  })

  it('starts from the remembered choice and labels where it came from', async () => {
    remember(REMEMBERED_SANDBOX, 'last')
    open()
    await screen.findByRole('radio', { name: 'Sandbox' })
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Unrestricted')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('choice-source')).toHaveTextContent('Last used')
    expect(screen.queryByTestId('notices')).toBeNull()
  })

  it('a replaced field gets a persistent banner, focus on that control, and one Enter does not start', async () => {
    remember(REMEMBERED_SANDBOX)
    open(status({ reason: 'docker-daemon-down' }))
    await screen.findByTestId('notices')

    expect(screen.getByTestId('notices')).toHaveTextContent("Sandbox isn't available")
    expect(screen.getByTestId('notices-region')).toContainElement(screen.getByTestId('notices'))
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    await vi.waitFor(() => expect(radio('Host')).toHaveFocus())
    expect(startButton()).not.toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(terminalSpawn).not.toHaveBeenCalled()
    expect(api.startSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('notices')).toBeInTheDocument()
  })

  it('an unregistered remembered agent is replaced with a notice naming both agents', async () => {
    remember({ ...REMEMBERED_SANDBOX, agentId: 'ghost', location: 'host' })
    open()
    await screen.findByTestId('notices')
    expect(screen.getByTestId('notices')).toHaveTextContent("ghost was last used but isn't available in this version, so Claude Code is selected.")
  })

  it('reports an untouched replaced field as a fallback when starting', async () => {
    remember(REMEMBERED_SANDBOX)
    open(status({ reason: 'docker-daemon-down' }))
    await screen.findByTestId('notices')

    await userEvent.click(startButton())

    expect(terminalSpawn).toHaveBeenCalledWith('ws', 80, 24, expect.objectContaining({ fallbackFields: ['location'] }))
  })

  it('touching a replaced control removes it from fallbackFields, even when the value is unchanged', async () => {
    remember(REMEMBERED_SANDBOX)
    open(status({ reason: 'docker-daemon-down' }))
    await screen.findByTestId('notices')

    await userEvent.click(radio('Host'))
    await userEvent.click(startButton())

    expect(terminalSpawn).toHaveBeenCalledWith('ws', 80, 24, expect.objectContaining({ fallbackFields: [] }))
  })

  it('Check again re-resolves the fields the user has not touched', async () => {
    remember(REMEMBERED_SANDBOX)
    open(status({ reason: 'docker-daemon-down' }))
    await screen.findByTestId('notices')
    api.getStatus.mockResolvedValue(ok(status()))

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))

    await vi.waitFor(() => expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.queryByTestId('notices')).toBeNull()
    expect(getDefaults).toHaveBeenCalledTimes(2)
  })

  it('Check again keeps a selection the user made', async () => {
    remember(REMEMBERED_SANDBOX)
    open(status({ reason: 'docker-daemon-down' }))
    await screen.findByTestId('notices')
    await userEvent.click(radio('Host'))
    api.getStatus.mockResolvedValue(ok(status()))

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))

    await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(screen.queryByTestId('notices')).toBeNull())
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
  })

  it('on timeout renders what has arrived, with the status-unknown notice and no autofocus on Start', async () => {
    vi.useFakeTimers()
    try {
      remember(REMEMBERED_SANDBOX)
      open(null)
      // The remembered options arrive quickly; only the status never does.
      await act(async () => {})
      await act(async () => { vi.advanceTimersByTime(STATUS_CHECK_TIMEOUT_MS) })

      expect(screen.getByTestId('notices')).toHaveTextContent("Couldn't check your sandbox status, so Host is selected.")
      expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
      expect(startButton()).not.toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the built-in choice when the remembered options cannot be read', async () => {
    getDefaults.mockRejectedValue(new Error('main unreachable'))
    open()
    await screen.findByRole('radio', { name: 'Host' })
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('choice-source')).toBeEmptyDOMElement()
    await vi.waitFor(() => expect(startButton()).toHaveFocus())
  })

  it('resolution runs once per fetch: later interaction never re-resolves', async () => {
    remember(REMEMBERED_SANDBOX)
    open()
    await screen.findByRole('radio', { name: 'Sandbox' })
    await userEvent.click(radio('Host'))
    await userEvent.click(radio('Auto mode'))
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    expect(getDefaults).toHaveBeenCalledTimes(1)
  })

  describe('host availability (C3)', () => {
    const CODEX_HOST: SessionChoice = { ...REMEMBERED_SANDBOX, agentId: 'codex', location: 'host' }

    function openWithCodex(): ReturnType<typeof open> {
      return open(status(), { agents: AGENT_DESCRIPTORS })
    }

    it('asks for fresh availability on every open', async () => {
      openWithCodex()
      await screen.findByRole('radio', { name: 'Host' })
      expect(getHostAvailability).toHaveBeenCalledWith(true)
    })

    it('flags a missing binary on the option and inline, without swapping the agent', async () => {
      getHostAvailability.mockResolvedValue(ok({ claude: 'found', codex: 'not-found' }))
      remember(CODEX_HOST)
      openWithCodex()

      const option = await screen.findByRole('radio', { name: 'Codex (may not be installed)' })
      expect(option).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByTestId('path-warning')).toHaveTextContent(
        "codex wasn't found on your PATH, so it may not be installed. Start may still work if your shell finds it.",
      )
      expect(screen.queryByTestId('notices')).toBeNull()
      expect(screen.getByTestId('will-start')).toHaveTextContent('Will start: Codex')
    })

    it('stays selectable and Start still starts it', async () => {
      getHostAvailability.mockResolvedValue(ok({ claude: 'found', codex: 'not-found' }))
      openWithCodex()
      await userEvent.click(await screen.findByRole('radio', { name: 'Codex (may not be installed)' }))

      await userEvent.click(startButton())

      expect(terminalSpawn).toHaveBeenCalledWith('ws', 80, 24, expect.objectContaining({ agentId: 'codex' }))
    })

    it('says nothing for a found binary, and nothing when availability cannot be read', async () => {
      remember(CODEX_HOST)
      const { unmount } = openWithCodex()
      await screen.findByRole('radio', { name: 'Codex' })
      expect(screen.queryByTestId('path-warning')).toBeNull()
      unmount()

      getHostAvailability.mockRejectedValue(new Error('unreachable'))
      openWithCodex()
      await screen.findByRole('radio', { name: 'Codex' })
      expect(screen.queryByTestId('path-warning')).toBeNull()
    })

    it('Check again re-reads availability', async () => {
      getHostAvailability.mockResolvedValue(ok({ claude: 'found', codex: 'not-found' }))
      // A remembered sandbox choice that can't be honored leaves a notice, which brings Check again.
      remember({ ...CODEX_HOST, location: 'sandbox' })
      open(status({ reason: 'docker-daemon-down' }), { agents: AGENT_DESCRIPTORS })
      await screen.findByTestId('path-warning')
      getHostAvailability.mockResolvedValue(ok({ claude: 'found', codex: 'found' }))

      await userEvent.click(screen.getByRole('button', { name: 'Check again' }))

      await vi.waitFor(() => expect(screen.queryByTestId('path-warning')).toBeNull())
      expect(getHostAvailability).toHaveBeenCalledTimes(2)
    })
  })

  describe('review fixes (B7)', () => {
    it('when Check again clears every notice, the banner says so instead of vanishing, and Check again stays', async () => {
      remember(REMEMBERED_SANDBOX)
      open(status({ reason: 'docker-daemon-down' }))
      await screen.findByTestId('notices')
      api.getStatus.mockResolvedValue(ok(status()))

      await userEvent.click(screen.getByRole('button', { name: 'Check again' }))

      expect(await screen.findByTestId('notices-outcome')).toHaveTextContent('Checked again: nothing is blocking your choices now.')
      expect(screen.queryByTestId('notices')).toBeNull()
      expect(screen.getByTestId('notices-region')).toContainElement(screen.getByTestId('notices-outcome'))
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    })

    it('with a notice but no replaced control on screen, focus goes to Check again', async () => {
      // The remembered agent is gone, but with one agent there is no Agent row to land on.
      remember({ ...REMEMBERED_SANDBOX, agentId: 'ghost', location: 'host' })
      open()
      await screen.findByTestId('notices')
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toHaveFocus())
      expect(startButton()).not.toHaveFocus()
    })

    it('a different workspace is a new opening: the skeleton shows again and the touched fields are forgotten', async () => {
      const { rerender } = open()
      await screen.findByRole('radio', { name: 'Host' })
      await userEvent.click(radio('Host'))

      rerender(<StartSessionChooser slug="other" skin={skin} agents={ONE_AGENT} onClose={vi.fn()} />)

      expect(screen.getByTestId('chooser-skeleton')).toBeInTheDocument()
      expect(getDefaults).toHaveBeenCalledWith('other')
    })

    it('Check again is bounded like the open: a status that never answers does not leave it busy forever', async () => {
      vi.useFakeTimers()
      try {
        open(status({ reason: 'docker-daemon-down' }))
        await act(async () => {})
        expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
        api.getStatus.mockReturnValue(new Promise(() => {}))

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })) })
        expect(screen.getByRole('button', { name: 'Checking…' })).toBeInTheDocument()
        await act(async () => { vi.advanceTimersByTime(STATUS_CHECK_TIMEOUT_MS) })

        expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    it('a re-render with a new agents array does not refetch or re-resolve', async () => {
      const { rerender } = open()
      await screen.findByRole('radio', { name: 'Host' })
      await userEvent.click(radio('Host'))

      rerender(<StartSessionChooser slug="ws" skin={skin} agents={[CLAUDE_DESCRIPTOR]} onClose={vi.fn()} />)
      rerender(<StartSessionChooser slug="ws" skin={skin} agents={[CLAUDE_DESCRIPTOR]} onClose={vi.fn()} />)

      expect(getDefaults).toHaveBeenCalledTimes(1)
      expect(api.getStatus).toHaveBeenCalledTimes(1)
    })

    it('a Check again that is still running when the chooser closes changes nothing afterwards', async () => {
      remember(REMEMBERED_SANDBOX)
      const { unmount } = open(status({ reason: 'docker-daemon-down' }))
      await screen.findByTestId('notices')
      let release: (v: unknown) => void = () => {}
      api.getEnvironment.mockReturnValue(new Promise((resolve) => { release = resolve }))
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
      unmount()
      await act(async () => { release(ok(null)) })

      expect(errors).not.toHaveBeenCalled()
      errors.mockRestore()
    })
  })

  describe('axe', () => {
    it('has no violations in the resolved default state', async () => {
      const { container } = open()
      await screen.findByRole('radio', { name: 'Host' })
      await expectNoAxeViolations(container)
    })

    it('has no violations in the sandbox state with Unrestricted selected', async () => {
      remember(REMEMBERED_SANDBOX)
      const { container } = open()
      await screen.findByRole('radio', { name: 'Sandbox' })
      await expectNoAxeViolations(container)
    })

    it('has no violations with notices and Check again showing', async () => {
      remember(REMEMBERED_SANDBOX)
      const { container } = open(status({ reason: 'docker-daemon-down' }))
      await screen.findByTestId('notices')
      await expectNoAxeViolations(container)
    })

    it('has no violations while the skeleton shows', async () => {
      const { container } = open(null)
      await expectNoAxeViolations(container)
    })
  })
})
