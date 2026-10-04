import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StartSessionChooser } from '../../../renderer/components/sandbox/StartSessionChooser'
import { RecreateDialog } from '../../../renderer/components/sandbox/RecreateDialog'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { useTerminalStore } from '../../../renderer/stores/terminal-store'
import {
  ELIGIBILITY_COPY,
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
Object.defineProperty(window, 'cornerOffice', { value: { sandbox: api, terminal: {}, on: vi.fn(() => vi.fn()) }, writable: true, configurable: true })

const ok = <T,>(data: T) => ({ data, error: null })
const HASH = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)

function plan(overrides: Partial<RecreatePlan> = {}): RecreatePlan {
  return { reason: 'mount-plan', specHash: HASH, newHostMounts: [], removedHostMounts: [], ...overrides }
}

function status(opts: { reason?: EligibilityReason; warnings?: EligibilityWarning[]; state?: SandboxStatus['session']['state']; plan?: RecreatePlan | null } = {}): SandboxStatus {
  return {
    workspaceSlug: 'ws',
    eligibility: opts.reason ? { ok: false, reason: opts.reason } : { ok: true, baseBranch: 'main', warnings: opts.warnings ?? [] },
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
  useTerminalStore.setState({ sessions: {}, overlayVisible: {}, spawnError: {}, sessionKind: {}, spawnFailure: {}, buildPrompt: {}, recreatePrompt: {} })
  setup()
})

function renderChooser(props: Partial<React.ComponentProps<typeof StartSessionChooser>> = {}) {
  const onStartHost = vi.fn()
  const onClose = vi.fn()
  const view = render(<StartSessionChooser slug="ws" onStartHost={onStartHost} onClose={onClose} {...props} />)
  return { onStartHost, onClose, ...view }
}

const radio = (name: string) => screen.getByRole('radio', { name })

describe('StartSessionChooser — choices', () => {
  it('is a dialog with Host selected and no sandbox toggles by default', () => {
    renderChooser()
    expect(screen.getByRole('dialog', { name: 'Start a session' })).toBeInTheDocument()
    expect(radio('Host')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Sandbox')).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('radiogroup', { name: 'Permissions' })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Network' })).toBeNull()
  })

  it('Start on Host calls onStartHost and closes, without touching the sandbox', async () => {
    const { onStartHost, onClose } = renderChooser()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onStartHost).toHaveBeenCalledTimes(1)
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
    expect(api.getEnvironment).toHaveBeenCalledWith(false)
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

  it('includes the §14.5 reason: "Run Claude Code on this machine once first"', () => {
    setup(status({ reason: 'claude-home-missing' }))
    renderChooser()
    fireEvent.focus(radio('Sandbox'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Run Claude Code on this machine once first, then try again.')
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
    const { onClose, onStartHost } = renderChooser()
    await chooseSandbox()
    await userEvent.click(radio('Auto mode'))
    await userEvent.click(radio('Unrestricted'))

    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.startSession).toHaveBeenCalledExactlyOnceWith('ws', 80, 24, 'auto', 'open')
    expect(onStartHost).not.toHaveBeenCalled()
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
    api.getStatus.mockResolvedValue(ok(status({ reason: 'claude-home-missing' })))
    renderChooser()
    await chooseSandbox()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(ELIGIBILITY_COPY['claude-home-missing'])
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
  const otherReasons: EligibilityReason[] = ['not-git', 'no-base-branch', 'claude-home-missing', 'repo-unsafe']

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
    expect(screen.getByRole('radiogroup', { name: 'Run Claude Code' })).toBeInTheDocument()
    expect(api.buildImage).not.toHaveBeenCalled()
  })

  it('Build starts the build (not a rebuild), shows progress with Show log, and calls no further startSession', async () => {
    let finish: (v: unknown) => void = () => {}
    api.buildImage.mockReturnValue(new Promise((r) => { finish = r }))
    const { rerender } = await startIntoMissingImage()
    const onShowLog = vi.fn()
    rerender(<StartSessionChooser slug="ws" onStartHost={vi.fn()} onClose={vi.fn()} onShowLog={onShowLog} />)

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
    expect(api.startSession).toHaveBeenLastCalledWith('ws', 80, 24, 'auto', 'open')
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
      renderChooser({ skin, onStartHost: () => input.focus() })
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
      const onStartHost = vi.fn(() => {
        setTimeout(() => {
          overlay = addOverlay()
        }, 0)
      })
      const { unmount } = renderChooser({ skin, onStartHost })
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
      const { onStartHost } = renderChooser()
      const start = screen.getByRole('button', { name: 'Start' })
      fireEvent.click(start)
      fireEvent.click(start)
      expect(onStartHost).toHaveBeenCalledTimes(1)
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
    it('focuses the selected radio on open', () => {
      renderChooser()
      expect(radio('Host')).toHaveFocus()
    })

    it('focuses Cancel when the panel swaps to the build confirm', async () => {
      await startIntoMissingImage()
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    })

    it('puts focus back on the selected radio when the build confirm is cancelled', async () => {
      await startIntoMissingImage()
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(radio('Sandbox')).toHaveFocus()
    })

    it('hands focus to the recreate dialog, and takes it back when that closes', async () => {
      useTerminalStore.setState({ recreatePrompt: { ws: { plan: plan() } } } as never)
      renderChooser()
      const dialog = screen.getByRole('alertdialog')
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(radio('Host')).toHaveFocus()
    })

    it('is a modal dialog and traps Tab in both directions', () => {
      renderChooser()
      expect(screen.getByRole('dialog', { name: 'Start a session' })).toHaveAttribute('aria-modal', 'true')

      const start = screen.getByRole('button', { name: 'Start' })
      start.focus()
      fireEvent.keyDown(start, { key: 'Tab' })
      expect(radio('Host')).toHaveFocus()

      fireEvent.keyDown(radio('Host'), { key: 'Tab', shiftKey: true })
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
