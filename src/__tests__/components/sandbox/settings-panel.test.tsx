import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SandboxSettingsPanel } from '../../../renderer/components/sandbox/SandboxSettingsPanel'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { LIVE_UPDATE_FAILURE_COPY } from '../../../renderer/utils/sandbox-copy'
import type { Workspace } from '@main/types/workspace'
import type { BlockedEntry, SandboxEnvironment, SandboxSettingsView, SandboxStatus, SandboxSummary } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// SandboxSettingsPanel — steps 5.8a (TRD §3.15.2, UX-M2, D4: the Docker, Image
// and Toolchains sections) and 5.8b (§3.8.2, §3.8.3, L4, L6: Network and
// Sandboxes).
// ---------------------------------------------------------------------------

const api = {
  getEnvironment: vi.fn(),
  getStatus: vi.fn(),
  getSummaries: vi.fn(),
  buildImage: vi.fn(),
  cancelBuild: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBlocked: vi.fn(),
  previewDelete: vi.fn(),
  recreate: vi.fn(),
  delete: vi.fn(),
}
Object.defineProperty(window, 'cornerOffice', { value: { sandbox: api, on: vi.fn(() => vi.fn()) }, writable: true, configurable: true })

const ok = <T,>(data: T) => ({ data, error: null })

const ENV_READY: SandboxEnvironment = { docker: 'ok', dockerVersion: '28.0.1', image: { state: 'ready', builtAt: '2026-01-02T03:04:05Z', sizeBytes: 1.3 * 1024 ** 3 } }
const SETTINGS: SandboxSettingsView = { toolchains: { node: true, go: false, buildBase: true }, defaultAllowlist: [], globalAllowlist: [], workspaceAllowlists: {} }

function status(slug: string, recreatePending: boolean): SandboxStatus {
  return {
    workspaceSlug: slug,
    eligibility: { ok: true, baseBranch: 'main', warnings: [] },
    exists: true,
    container: 'stopped',
    worktree: 'ready',
    session: { state: 'idle', permissionMode: null, networkMode: null, lastExit: null },
    git: null,
    recreatePending,
    recreatePlan: null,
    channel: 'none',
  }
}

function setStore(partial: Partial<ReturnType<typeof useSandboxStore.getState>> = {}): void {
  useSandboxStore.setState({
    environment: ENV_READY,
    settings: SETTINGS,
    status: {},
    summaries: {},
    build: { running: false, lines: [], phase: 'idle', requestedFor: null },
    ...partial,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const fn of Object.values(api)) fn.mockResolvedValue(ok(null))
  api.getEnvironment.mockResolvedValue(ok(ENV_READY))
  api.getSettings.mockResolvedValue(ok(SETTINGS))
  api.getBlocked.mockResolvedValue(ok([]))
  useWorkspaceStore.setState({ workspaces: [] })
  setStore()
})

describe('mount', () => {
  it('refreshes the environment, settings and summaries, then each sandbox status', async () => {
    api.getSummaries.mockResolvedValue(ok({ a: { exists: true, running: false, unmergedBranches: [] }, b: { exists: true, running: false, unmergedBranches: [] } }))
    api.getStatus.mockImplementation(async (slug: string) => ok(status(slug, false)))

    render(<SandboxSettingsPanel />)

    await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalledWith('a'))
    expect(api.getStatus).toHaveBeenCalledWith('b')
    expect(api.getEnvironment).toHaveBeenCalledWith(true)
    expect(api.getSettings).toHaveBeenCalled()
    expect(api.getSummaries).toHaveBeenCalled()
  })
})

describe('Docker section', () => {
  it('shows the state and version', () => {
    render(<SandboxSettingsPanel />)
    const section = screen.getByRole('region', { name: 'Docker' })
    expect(section).toHaveTextContent('Docker is running')
    expect(section).toHaveTextContent('version 28.0.1')
  })

  it.each([
    ['not-installed', "Docker isn't installed"],
    ['daemon-down', "The Docker daemon isn't running. Start it, then press Check again."],
    ['no-permission', "Your user can't access Docker"],
    ['rootless-unsupported', "Rootless Docker isn't supported"],
    ['podman-unsupported', "Podman isn't supported"],
    ['too-old', 'Sandbox needs Docker 28 or newer. Update Docker, then press Check again.'],
    ['unsupported-daemon', "Remote and Docker Desktop daemons aren't supported. Switch to a local one."],
  ] as const)('explains %s', (docker, copy) => {
    api.getEnvironment.mockResolvedValue(ok({ ...ENV_READY, docker, dockerVersion: null }))
    setStore({ environment: { ...ENV_READY, docker, dockerVersion: null } })
    render(<SandboxSettingsPanel />)
    expect(screen.getByRole('region', { name: 'Docker' })).toHaveTextContent(copy)
  })

  it('says it is checking before the environment is known, and Check again forces a refresh', async () => {
    api.getEnvironment.mockResolvedValue(ok(null))
    setStore({ environment: null })
    render(<SandboxSettingsPanel />)
    expect(screen.getByText('Checking Docker…')).toBeInTheDocument()

    api.getEnvironment.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(api.getEnvironment).toHaveBeenCalledWith(true)
  })
})

describe('Image section', () => {
  const image = () => screen.getByRole('region', { name: 'Image' })

  it('shows state, built-at and size', () => {
    render(<SandboxSettingsPanel />)
    expect(image()).toHaveTextContent('Ready')
    expect(image()).toHaveTextContent('built')
    expect(image()).toHaveTextContent('1.3 GB')
  })

  it.each([
    ['absent', 'Not built yet'],
    ['building', 'Building…'],
    ['stale', 'Ready, but out of date'],
    ['failed', 'The last build failed'],
  ] as const)('describes the %s state', (state, copy) => {
    const env = { ...ENV_READY, image: { state, builtAt: null, sizeBytes: null } }
    api.getEnvironment.mockResolvedValue(ok(env))
    setStore({ environment: env })
    render(<SandboxSettingsPanel />)
    expect(image()).toHaveTextContent(copy)
  })

  it('shows MB for a small image and nothing for an unparseable build time', () => {
    const env = { ...ENV_READY, image: { state: 'ready' as const, builtAt: 'not a date', sizeBytes: 300 * 1024 ** 2 } }
    api.getEnvironment.mockResolvedValue(ok(env))
    setStore({ environment: env })
    render(<SandboxSettingsPanel />)
    expect(image()).toHaveTextContent('300 MB')
    expect(image()).not.toHaveTextContent('built')
  })

  it('shows the stale banner only for a stale image', () => {
    const stale = { ...ENV_READY, image: { ...ENV_READY.image, state: 'stale' as const } }
    api.getEnvironment.mockResolvedValue(ok(stale))
    setStore({ environment: stale })
    const { unmount } = render(<SandboxSettingsPanel />)
    expect(screen.getByRole('status')).toHaveTextContent('The image is out of date. Rebuild to apply.')
    unmount()

    setStore()
    render(<SandboxSettingsPanel />)
    expect(screen.queryByText(/out of date\. Rebuild/)).toBeNull()
  })

  it('first build: confirms with size and time, never starts a session, then builds without a rebuild', async () => {
    const absent = { ...ENV_READY, image: { state: 'absent' as const, builtAt: null, sizeBytes: null } }
    api.getEnvironment.mockResolvedValue(ok(absent))
    api.buildImage.mockResolvedValue(ok({ ok: true }))
    setStore({ environment: absent })
    render(<SandboxSettingsPanel />)

    await userEvent.click(screen.getByRole('button', { name: 'Build image' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('About 1.4 GB, takes several minutes')
    expect(api.buildImage).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Build' }))
    expect(api.buildImage).toHaveBeenCalledWith(false)
  })

  it('rebuild: confirms, then builds with rebuild true; cancelling the confirm builds nothing', async () => {
    api.buildImage.mockResolvedValue(ok({ ok: true }))
    render(<SandboxSettingsPanel />)

    await userEvent.click(screen.getByRole('button', { name: 'Rebuild image' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('newer Claude Code')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.buildImage).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Rebuild image' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Rebuild' }))
    expect(api.buildImage).toHaveBeenCalledWith(true)
  })

  it('a failed build call does not crash the panel', async () => {
    api.buildImage.mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'x' } })
    render(<SandboxSettingsPanel />)

    await userEvent.click(screen.getByRole('button', { name: 'Rebuild image' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Rebuild' }))

    await vi.waitFor(() => expect(useSandboxStore.getState().build.phase).toBe('failed'))
    expect(screen.getByText('Build failed')).toBeInTheDocument()
  })

  it('while a build runs: Build is aria-disabled with a reason, and Cancel build calls cancelBuild', async () => {
    setStore({ build: { running: true, lines: [], phase: 'running', requestedFor: null } })
    render(<SandboxSettingsPanel />)

    const buildButton = screen.getByRole('button', { name: 'Rebuild image' })
    expect(buildButton).toHaveAttribute('aria-disabled', 'true')
    expect(buildButton).not.toBeDisabled()
    await userEvent.click(buildButton)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.focus(buildButton)
    expect(screen.getByRole('tooltip')).toHaveTextContent('A build is already running')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel build' }))
    expect(api.cancelBuild).toHaveBeenCalled()
  })

  it('has no Cancel button when no build runs', () => {
    render(<SandboxSettingsPanel />)
    expect(screen.queryByRole('button', { name: 'Cancel build' })).toBeNull()
  })

  it.each([
    ['running', 'Building…'],
    ['done', 'Image ready'],
    ['failed', 'Build failed'],
    ['cancelled', 'Cancelled'],
  ] as const)('shows the %s status in ONE polite status line', (phase, copy) => {
    setStore({ build: { running: phase === 'running', lines: ['step 1'], phase, requestedFor: null } })
    render(<SandboxSettingsPanel />)

    const live = document.querySelectorAll('[aria-live]')
    expect(live).toHaveLength(1)
    expect(live[0]).toHaveAttribute('aria-live', 'polite')
    expect(live[0]).toHaveTextContent(copy)
  })

  it('log lines have no aria-live and the log is not a role=log (UX-M2)', () => {
    setStore({ build: { running: true, lines: ['step 1', 'step 2'], phase: 'running', requestedFor: null } })
    render(<SandboxSettingsPanel />)

    const log = screen.getByLabelText('Build log')
    expect(log).toHaveTextContent('step 1')
    expect(log).toHaveTextContent('step 2')
    expect(log.closest('[aria-live]')).toBeNull()
    expect(log.querySelector('[aria-live]')).toBeNull()
    expect(screen.queryByRole('log')).toBeNull()
    expect(log).toHaveAttribute('role', 'region')
  })

  it.each(['office', 'realm'] as const)('every button has a visible focus style (%s)', (skin) => {
    setStore({ build: { running: false, lines: ['a'], phase: 'done', requestedFor: null } })
    render(<SandboxSettingsPanel skin={skin} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) expect(button.className).toContain('focus-visible:outline')
  })

  it('Jump to latest scrolls the log to the end', async () => {
    setStore({ build: { running: false, lines: ['a', 'b', 'c'], phase: 'done', requestedFor: null } })
    render(<SandboxSettingsPanel />)
    const log = screen.getByLabelText('Build log')
    Object.defineProperty(log, 'scrollHeight', { value: 500, configurable: true })

    await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    expect(log.scrollTop).toBe(500)
  })

  it('hides the log and Jump to latest when there are no lines', () => {
    render(<SandboxSettingsPanel />)
    expect(screen.queryByLabelText('Build log')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  describe('recreate prompt', () => {
    it('counts sandboxes still on the previous image and offers Recreate now', async () => {
      const onRecreateNow = vi.fn()
      setStore({ status: { a: status('a', true), b: status('b', true), c: status('c', false) } })
      render(<SandboxSettingsPanel onRecreateNow={onRecreateNow} />)

      expect(image()).toHaveTextContent('2 sandboxes use the previous image. Recreate now?')
      await userEvent.click(screen.getByRole('button', { name: 'Recreate now' }))
      expect(onRecreateNow).toHaveBeenCalledWith(['a', 'b'])
    })

    it('uses the singular for one sandbox, and no "Recreate now" button without a handler', () => {
      setStore({ status: { a: status('a', true) } })
      render(<SandboxSettingsPanel />)
      expect(image()).toHaveTextContent('1 sandbox uses the previous image. Recreate now?')
      expect(screen.queryByRole('button', { name: 'Recreate now' })).toBeNull()
    })

    it('without a handler, each pending sandbox gets its own Recreate through the confirm-first dialog', async () => {
      const plan = { reason: 'image' as const, specHash: 'a'.repeat(64), newHostMounts: [], removedHostMounts: [] }
      const pending = { ...status('a', true), recreatePlan: plan }
      api.getStatus.mockImplementation(async () => ok(pending))
      api.getSummaries.mockResolvedValue(ok({ a: { exists: true, running: false, unmergedBranches: [] } }))
      api.recreate.mockResolvedValue(ok({ ok: true }))
      useWorkspaceStore.setState({ workspaces: [{ slug: 'a', displayName: 'Alpha' } as never] })
      setStore({ status: { a: pending }, summaries: { a: { exists: true, running: false, unmergedBranches: [] } } })
      render(<SandboxSettingsPanel />)

      await userEvent.click(within(image()).getByRole('button', { name: 'Recreate sandbox for Alpha' }))
      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent('Recreate the sandbox?')
      expect(api.recreate).not.toHaveBeenCalled()

      await userEvent.click(within(dialog).getByRole('button', { name: 'Recreate' }))
      await vi.waitFor(() => expect(api.recreate).toHaveBeenCalledWith('a', false, 'a'.repeat(64)))
    })

    it('shows no prompt when nothing is pending', () => {
      setStore({ status: { a: status('a', false) } })
      render(<SandboxSettingsPanel />)
      expect(screen.queryByText(/previous image/)).toBeNull()
    })
  })
})

describe('Toolchains section', () => {
  const toolchains = () => screen.getByRole('region', { name: 'Toolchains' })

  it('reflects the saved toggles', () => {
    render(<SandboxSettingsPanel />)
    expect(screen.getByRole('checkbox', { name: 'Node 22 + pnpm' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Go' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'build-base (C toolchain)' })).toBeChecked()
  })

  it('saves a toggle with the other two preserved', async () => {
    api.updateSettings.mockResolvedValue(ok({ ...SETTINGS, toolchains: { node: true, go: true, buildBase: true } }))
    render(<SandboxSettingsPanel />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Go' }))

    expect(api.updateSettings).toHaveBeenCalledWith({ toolchains: { node: true, go: true, buildBase: true } })
    await vi.waitFor(() => expect(useSandboxStore.getState().settings?.toolchains.go).toBe(true))
  })

  it('shows an alert when saving fails', async () => {
    api.updateSettings.mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'x' } })
    render(<SandboxSettingsPanel />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Go' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the toolchain settings.')
  })

  it('explains the toggles through DisabledReason (never native disabled) until settings have loaded', async () => {
    api.getSettings.mockResolvedValue(ok(null))
    setStore({ settings: null })
    render(<SandboxSettingsPanel />)

    const go = screen.getByRole('checkbox', { name: 'Go' })
    expect(go).toHaveAttribute('aria-disabled', 'true')
    expect(go).toHaveAttribute('aria-checked', 'false')
    expect(go).not.toBeDisabled()
    expect(go).toHaveAttribute('tabindex', '0')
    fireEvent.focus(go)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Loading settings…')

    await userEvent.click(go)
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it('has no native disabled input anywhere in the panel', () => {
    render(<SandboxSettingsPanel />)
    expect(document.querySelectorAll('input:disabled, button:disabled')).toHaveLength(0)
  })

  it.each([
    ['Core tools', 'Always included'],
    ['GitHub CLI (gh)', 'Always included'],
    ['Claude Code', 'Always included'],
    ['Python 3.12 + uv + bun', 'Required by the corner-office plugin'],
  ])('locked row "%s" is checked, aria-disabled (not disabled) and explains why', (name, reason) => {
    render(<SandboxSettingsPanel />)
    const box = screen.getByRole('checkbox', { name: new RegExp(name.replace(/[()+]/g, '\\$&')) })

    expect(box).toBeChecked()
    expect(box).toHaveAttribute('aria-disabled', 'true')
    expect(box).not.toBeDisabled()

    fireEvent.focus(box)
    expect(screen.getByRole('tooltip')).toHaveTextContent(reason)
  })

  it('a locked row cannot be toggled', async () => {
    render(<SandboxSettingsPanel />)
    const box = screen.getByRole('checkbox', { name: /Claude Code/ })
    await userEvent.click(box)
    expect(box).toBeChecked()
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it('states the Python row note in the row itself, and that a change makes the image out of date', () => {
    render(<SandboxSettingsPanel />)
    expect(toolchains()).toHaveTextContent('Python 3.12 + uv + bun — Required by the corner-office plugin')
    expect(toolchains()).toHaveTextContent('Changing a toolchain marks the image out of date until you rebuild it.')
  })
})

describe('realm skin', () => {
  it('renders every section with the same copy', async () => {
    setStore({ build: { running: false, lines: ['x'], phase: 'done', requestedFor: null }, status: { a: status('a', true) } })
    render(<SandboxSettingsPanel skin="realm" onRecreateNow={vi.fn()} />)

    for (const name of ['Docker', 'Image', 'Toolchains']) expect(screen.getByRole('region', { name })).toBeInTheDocument()
    expect(screen.getByText('Image ready')).toBeInTheDocument()
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Recreate now' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 5.8b — Network
// ---------------------------------------------------------------------------

function ws(slug: string, displayName: string): Workspace {
  return { slug, displayName } as Workspace
}

const NET_SETTINGS: SandboxSettingsView = {
  toolchains: { node: true, go: true, buildBase: true },
  defaultAllowlist: ['api.anthropic.com', 'github.com'],
  globalAllowlist: ['global.dev'],
  workspaceAllowlists: { alpha: ['alpha-only.dev'] },
}

const blockedEntry = (domain: string, count = 1): BlockedEntry => ({ domain, count, firstSeen: 't1', lastSeen: 't2' })

describe('Network section', () => {
  const network = () => screen.getByRole('region', { name: 'Network' })

  function setNetwork(opts: { blocked?: BlockedEntry[]; settings?: SandboxSettingsView | null; status?: Partial<SandboxStatus> } = {}): void {
    useWorkspaceStore.setState({ workspaces: [ws('alpha', 'Alpha'), ws('beta', 'Beta')] })
    api.getBlocked.mockResolvedValue(ok(opts.blocked ?? []))
    api.updateSettings.mockResolvedValue(ok(NET_SETTINGS))
    api.getSettings.mockResolvedValue(ok(opts.settings === undefined ? NET_SETTINGS : opts.settings))
    api.getStatus.mockImplementation(async (slug: string) => ok({ ...status(slug, false), ...(slug === 'alpha' ? opts.status : {}) }))
    setStore({ settings: opts.settings === undefined ? NET_SETTINGS : opts.settings, blocked: { alpha: opts.blocked ?? [] }, status: {} })
  }

  it('shows a loading line until the settings arrive', () => {
    setNetwork({ settings: null })
    api.getSettings.mockReturnValue(new Promise(() => {}))
    render(<SandboxSettingsPanel />)
    expect(network()).toHaveTextContent('Loading settings…')
    expect(within(network()).queryByRole('textbox')).toBeNull()
    expect(within(network()).queryByRole('alert')).toBeNull()
  })

  it('shows a failure with Retry, not "Loading settings…" forever, when the settings never load', async () => {
    setNetwork({ settings: null })
    api.getSettings.mockResolvedValue({ data: null, error: { code: 'NOT_READY', message: 'x' } })
    render(<SandboxSettingsPanel />)

    const alert = await within(network()).findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the sandbox settings.')
    expect(network()).not.toHaveTextContent('Loading settings…')

    api.getSettings.mockResolvedValue(ok(NET_SETTINGS))
    await userEvent.click(within(network()).getByRole('button', { name: 'Retry' }))

    expect(await within(network()).findByRole('heading', { name: 'Allowed in every sandbox' })).toBeInTheDocument()
    expect(within(network()).queryByRole('alert')).toBeNull()
  })

  it('a thrown settings fetch is reported the same way', async () => {
    setNetwork({ settings: null })
    api.getSettings.mockRejectedValue(new Error('boom'))
    render(<SandboxSettingsPanel />)
    expect(await within(network()).findByRole('alert')).toHaveTextContent('Could not load the sandbox settings.')
  })

  it('lists the built-in defaults read-only, with their count', async () => {
    setNetwork()
    render(<SandboxSettingsPanel />)
    expect(within(network()).getByText('Always allowed (2 sites)')).toBeInTheDocument()
    const list = within(network()).getByText('api.anthropic.com').closest('ul') as HTMLElement
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['api.anthropic.com', 'github.com'])
    expect(within(list).queryByRole('button')).toBeNull()
  })

  describe('allowlist editors', () => {
    it('adds to and removes from the global list through updateSettings', async () => {
      setNetwork()
      render(<SandboxSettingsPanel />)
      const global = within(network()).getByRole('heading', { name: 'Allowed in every sandbox' }).parentElement as HTMLElement

      await userEvent.type(within(global).getByRole('textbox', { name: 'Add allowlist entry' }), 'new.dev{Enter}')
      expect(api.updateSettings).toHaveBeenLastCalledWith({ globalAllowlist: ['global.dev', 'new.dev'] })

      await userEvent.click(within(global).getByRole('button', { name: 'Remove global.dev' }))
      expect(api.updateSettings).toHaveBeenLastCalledWith({ globalAllowlist: [] })
    })

    it("shows the picked workspace's additions and edits only that workspace", async () => {
      setNetwork()
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)
      expect(await within(network()).findByRole('heading', { name: 'Also allowed in Alpha' })).toBeInTheDocument()
      const mine = within(network()).getByRole('heading', { name: 'Also allowed in Alpha' }).parentElement as HTMLElement
      expect(within(mine).getByText('alpha-only.dev')).toBeInTheDocument()

      await userEvent.type(within(mine).getByRole('textbox', { name: 'Add allowlist entry' }), 'more.dev{Enter}')
      expect(api.updateSettings).toHaveBeenLastCalledWith({ workspaceAllowlist: { workspaceSlug: 'alpha', entries: ['alpha-only.dev', 'more.dev'] } })

      await userEvent.click(within(mine).getByRole('button', { name: 'Remove alpha-only.dev' }))
      expect(api.updateSettings).toHaveBeenLastCalledWith({ workspaceAllowlist: { workspaceSlug: 'alpha', entries: [] } })
    })

    it('picking another workspace switches the list and loads its Blocked feed', async () => {
      setNetwork()
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)
      await userEvent.selectOptions(within(network()).getByRole('combobox', { name: 'Workspace' }), 'beta')

      expect(within(network()).getByRole('heading', { name: 'Also allowed in Beta' })).toBeInTheDocument()
      await vi.waitFor(() => expect(api.getBlocked).toHaveBeenCalledWith('beta'))
    })

    it('opens on the first workspace when none is named, or the named one is unknown', async () => {
      setNetwork()
      render(<SandboxSettingsPanel initialWorkspace="ghost" />)
      expect(await within(network()).findByRole('heading', { name: 'Also allowed in Alpha' })).toBeInTheDocument()
      expect(within(network()).getByRole('combobox', { name: 'Workspace' })).toHaveValue('alpha')
    })

    it('announces an invalid entry in role="alert" with aria-invalid', async () => {
      setNetwork()
      render(<SandboxSettingsPanel />)
      const global = within(network()).getByRole('heading', { name: 'Allowed in every sandbox' }).parentElement as HTMLElement
      const input = within(global).getByRole('textbox', { name: 'Add allowlist entry' })
      await userEvent.type(input, 'not a domain')

      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(within(global).getByRole('alert')).toHaveTextContent('Not a valid domain')
      expect(api.updateSettings).not.toHaveBeenCalled()
    })

    it('says so when saving fails', async () => {
      setNetwork()
      api.updateSettings.mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'x' } })
      render(<SandboxSettingsPanel />)
      const global = within(network()).getByRole('heading', { name: 'Allowed in every sandbox' }).parentElement as HTMLElement
      await userEvent.type(within(global).getByRole('textbox', { name: 'Add allowlist entry' }), 'new.dev{Enter}')

      expect(await screen.findByText('Could not save the allowlist.')).toBeInTheDocument()
      expect(screen.getByText('Could not save the allowlist.')).toHaveAttribute('role', 'alert')
    })

    it('shows a message instead of the picker when there are no workspaces', () => {
      setNetwork()
      useWorkspaceStore.setState({ workspaces: [] })
      render(<SandboxSettingsPanel />)
      expect(within(network()).getByText('No workspaces yet.')).toBeInTheDocument()
      expect(within(network()).queryByRole('combobox')).toBeNull()
    })
  })

  it('carries the L6 note about connections that are already open', () => {
    setNetwork()
    render(<SandboxSettingsPanel />)
    expect(network()).toHaveTextContent('Connections that are already open stay open until the session ends.')
  })

  describe('live update failure', () => {
    it('shows the fixed failure copy in role="alert" when the picked workspace failed its last update', async () => {
      setNetwork({ status: { liveUpdate: 'failed' } })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)
      const alert = await within(network()).findByText(LIVE_UPDATE_FAILURE_COPY)
      expect(alert).toHaveAttribute('role', 'alert')
    })

    it('shows nothing when the last update succeeded or there was none', async () => {
      setNetwork({ status: { liveUpdate: 'ok' } })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)
      await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalledWith('alpha'))
      expect(screen.queryByText(LIVE_UPDATE_FAILURE_COPY)).toBeNull()
    })
  })

  describe('Blocked feed — "Requested by the agent"', () => {
    it('says nothing was blocked when the feed is empty', async () => {
      setNetwork()
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)
      expect(await within(network()).findByRole('heading', { name: 'Requested by the agent' })).toBeInTheDocument()
      expect(network()).toHaveTextContent('Nothing was blocked in Alpha.')
    })

    it('lists each blocked name with its request count, as plain text, with a caution that the agent chose it', async () => {
      setNetwork({ blocked: [blockedEntry('crates.io', 3), blockedEntry('<b>evil</b>.dev', 1)] })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)

      expect(await within(network()).findByText('crates.io')).toBeInTheDocument()
      expect(network()).toHaveTextContent('3 requests')
      expect(network()).toHaveTextContent('1 request')
      expect(network()).toHaveTextContent('The sandbox agent chose these names.')
      // Rendered as text, never as markup.
      expect(network().querySelector('b')).toBeNull()
    })

    it('Allow for this workspace appends the domain to that workspace only', async () => {
      setNetwork({ blocked: [blockedEntry('crates.io')] })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)

      await userEvent.click(await within(network()).findByRole('button', { name: 'Allow for this workspace: crates.io' }))

      expect(api.updateSettings).toHaveBeenCalledWith({ workspaceAllowlist: { workspaceSlug: 'alpha', entries: ['alpha-only.dev', 'crates.io'] } })
    })

    it('two quick allows both end up saved: writes run one at a time on the latest settings', async () => {
      setNetwork({ blocked: [blockedEntry('one.dev'), blockedEntry('two.dev')] })
      let server: SandboxSettingsView = NET_SETTINGS
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let first = true
      api.updateSettings.mockImplementation(async (patch: { workspaceAllowlist?: { entries: string[] } }) => {
        if (first) {
          first = false
          await gate
        }
        if (patch.workspaceAllowlist) server = { ...server, workspaceAllowlists: { ...server.workspaceAllowlists, alpha: patch.workspaceAllowlist.entries } }
        return ok(server)
      })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)
      const one = await within(network()).findByRole('button', { name: 'Allow for this workspace: one.dev' })
      const two = within(network()).getByRole('button', { name: 'Allow for this workspace: two.dev' })

      fireEvent.click(one)
      fireEvent.click(two)
      // The second write has not started while the first is in flight.
      await act(async () => {
        await Promise.resolve()
      })
      expect(api.updateSettings).toHaveBeenCalledTimes(1)
      release()

      await vi.waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2))
      expect(api.updateSettings).toHaveBeenNthCalledWith(1, { workspaceAllowlist: { workspaceSlug: 'alpha', entries: ['alpha-only.dev', 'one.dev'] } })
      expect(api.updateSettings).toHaveBeenNthCalledWith(2, { workspaceAllowlist: { workspaceSlug: 'alpha', entries: ['alpha-only.dev', 'one.dev', 'two.dev'] } })
      expect(server.workspaceAllowlists.alpha).toEqual(['alpha-only.dev', 'one.dev', 'two.dev'])
    })

    it('a failed write does not wedge the queue: the next click still saves', async () => {
      setNetwork({ blocked: [blockedEntry('one.dev'), blockedEntry('two.dev')] })
      api.updateSettings.mockResolvedValueOnce({ data: null, error: { code: 'INTERNAL_ERROR', message: 'x' } })
      api.updateSettings.mockResolvedValue(ok(NET_SETTINGS))
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)

      await userEvent.click(await within(network()).findByRole('button', { name: 'Allow for this workspace: one.dev' }))
      expect(await screen.findByText('Could not save the allowlist.')).toBeInTheDocument()
      await userEvent.click(within(network()).getByRole('button', { name: 'Allow for this workspace: two.dev' }))

      await vi.waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(screen.queryByText('Could not save the allowlist.')).toBeNull())
    })

    it('Allow everywhere asks first, names the workspace and the domain, and does nothing on Cancel', async () => {
      setNetwork({ blocked: [blockedEntry('crates.io')] })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)

      await userEvent.click(await within(network()).findByRole('button', { name: 'Allow everywhere: crates.io' }))

      const dialog = screen.getByRole('alertdialog')
      expect(dialog).toHaveTextContent('Allow crates.io for every sandbox? This site was requested by the agent in Alpha.')
      expect(api.updateSettings).not.toHaveBeenCalled()

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(api.updateSettings).not.toHaveBeenCalled()
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('confirming Allow everywhere adds the domain to the global list', async () => {
      setNetwork({ blocked: [blockedEntry('crates.io')] })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)

      await userEvent.click(await within(network()).findByRole('button', { name: 'Allow everywhere: crates.io' }))
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Allow everywhere' }))

      expect(api.updateSettings).toHaveBeenCalledWith({ globalAllowlist: ['global.dev', 'crates.io'] })
    })

    it.each([
      ['a built-in default', 'github.com'],
      ['a subdomain of a built-in default', 'gist.github.com'],
      ['a global addition', 'global.dev'],
      ['a workspace addition', 'alpha-only.dev'],
    ])('a name that is already allowed (%s) shows Allowed instead of buttons', async (_label, domain) => {
      setNetwork({ blocked: [blockedEntry(domain)] })
      render(<SandboxSettingsPanel initialWorkspace="alpha" />)

      const feed = (await within(network()).findByRole('heading', { name: 'Requested by the agent' })).parentElement as HTMLElement
      const row = (await within(feed).findByText(domain)).closest('li') as HTMLElement
      expect(row).toHaveTextContent('Allowed')
      expect(within(row).queryByRole('button')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// 5.8b — Sandboxes
// ---------------------------------------------------------------------------

describe('Sandboxes section', () => {
  const sandboxes = () => screen.getByRole('region', { name: 'Sandboxes' })
  const summary = (overrides: Partial<SandboxSummary> = {}): SandboxSummary => ({ exists: true, running: false, unmergedBranches: [], ...overrides })

  it('explains the empty state', () => {
    render(<SandboxSettingsPanel />)
    expect(sandboxes()).toHaveTextContent('No sandboxes yet.')
    expect(within(sandboxes()).queryByRole('listitem')).toBeNull()
  })

  it('lists each sandbox with its state and unmerged branch count, and a Delete named for the workspace', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('alpha', 'Alpha'), ws('beta', 'Beta')] })
    api.getStatus.mockImplementation(async (slug: string) => ok(status(slug, false)))
    api.getSummaries.mockResolvedValue(ok({ alpha: summary({ unmergedBranches: ['feat/a'] }), beta: summary({ unmergedBranches: ['x', 'y'] }), gone: summary({ exists: false }) }))
    setStore({ summaries: { alpha: summary({ unmergedBranches: ['feat/a'] }), beta: summary({ unmergedBranches: ['x', 'y'] }), gone: summary({ exists: false }) }, status: { alpha: status('alpha', false), beta: status('beta', false) } })
    render(<SandboxSettingsPanel />)

    const items = within(sandboxes()).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Alpha')
    expect(items[0]).toHaveTextContent('Stopped · 1 unmerged branch')
    expect(items[1]).toHaveTextContent('Stopped · 2 unmerged branches')
    expect(within(items[0]).getByRole('button', { name: 'Delete sandbox for Alpha' })).toBeInTheDocument()
    expect(within(items[0]).queryByRole('button', { name: /Hand off|Recreate/ })).toBeNull()
  })

  it('falls back to the slug when the workspace is unknown', () => {
    const only = { alpha: summary() }
    api.getSummaries.mockResolvedValue(ok(only))
    setStore({ summaries: only, status: { alpha: status('alpha', false) } })
    render(<SandboxSettingsPanel />)
    expect(within(sandboxes()).getByRole('button', { name: 'Delete sandbox for alpha' })).toBeInTheDocument()
  })

  it('shows Running and Ending… and offers no Delete while a session is active', () => {
    useWorkspaceStore.setState({ workspaces: [ws('alpha', 'Alpha'), ws('beta', 'Beta')] })
    const running = { ...status('alpha', false), session: { state: 'running' as const, permissionMode: 'skip' as const, networkMode: 'allowlist' as const, lastExit: null } }
    const ending = { ...status('beta', false), session: { state: 'ending' as const, permissionMode: null, networkMode: null, lastExit: null } }
    const both = { alpha: summary({ running: true }), beta: summary() }
    api.getSummaries.mockResolvedValue(ok(both))
    api.getStatus.mockImplementation(async (slug: string) => ok(slug === 'alpha' ? running : ending))
    setStore({ summaries: both, status: { alpha: running, beta: ending } })
    render(<SandboxSettingsPanel />)

    const items = within(sandboxes()).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Running')
    expect(items[1]).toHaveTextContent('Ending…')
    expect(within(sandboxes()).queryByRole('button', { name: /Delete sandbox/ })).toBeNull()
  })

  it('treats a running summary as Running even before the status arrives', () => {
    setStore({ summaries: { alpha: summary({ running: true }) }, status: {} })
    render(<SandboxSettingsPanel />)
    expect(sandboxes()).toHaveTextContent('Running')
  })

  it('Delete goes through the confirm and then deletes', async () => {
    useWorkspaceStore.setState({ workspaces: [ws('alpha', 'Alpha')] })
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 0, unmergedBranches: [] }))
    api.delete.mockResolvedValue(ok({ ok: true }))
    api.getStatus.mockImplementation(async (slug: string) => ok(status(slug, false)))
    api.getSummaries.mockResolvedValue(ok({ alpha: summary() }))
    setStore({ summaries: { alpha: summary() }, status: { alpha: status('alpha', false) } })
    render(<SandboxSettingsPanel />)

    await userEvent.click(within(sandboxes()).getByRole('button', { name: 'Delete sandbox for Alpha' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete the sandbox?')
    expect(api.delete).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith('alpha', false))
  })
})
