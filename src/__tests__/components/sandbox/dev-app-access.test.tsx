import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SandboxSettingsPanel } from '../../../renderer/components/sandbox/SandboxSettingsPanel'
import { RecreateDialog } from '../../../renderer/components/sandbox/RecreateDialog'
import { SandboxActions } from '../../../renderer/components/sandbox/SandboxActions'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import {
  DEV_ACCESS_APPLIES,
  DEV_ACCESS_HELP,
  DEV_ACCESS_NEXT_START,
  DEV_ACCESS_SAVE_FAILED,
  DEV_ACCESS_ROUTINE_USE,
  DEV_ACCESS_TOGGLE,
  RECREATE_REASON_COPY,
} from '../../../renderer/utils/sandbox-copy'
import type { Workspace } from '@main/types/workspace'
import type { RecreatePlan, SandboxEnvironment, SandboxSettingsView, SandboxStatus } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// "Dev app access" (#0038 3a.3): the settings section and the recreate dialog's CDP line.
// ---------------------------------------------------------------------------

const api = {
  getEnvironment: vi.fn(),
  getStatus: vi.fn(),
  getSummaries: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBlocked: vi.fn(),
  recreate: vi.fn(),
}
Object.defineProperty(window, 'cornerOffice', { value: { sandbox: api, terminal: {}, on: vi.fn(() => vi.fn()) }, writable: true, configurable: true })

const ok = <T,>(data: T) => ({ data, error: null })
const ENV_READY: SandboxEnvironment = { docker: 'ok', dockerVersion: '28.0.1', image: { state: 'ready', builtAt: null, sizeBytes: null } }
const HASH = 'a'.repeat(64)
const WS = { slug: 'ws', displayName: 'My Workspace' } as Workspace

function settings(port: number | null): SandboxSettingsView {
  return {
    toolchains: { node: true, go: false, buildBase: true },
    defaultAllowlist: [],
    globalAllowlist: [],
    workspaceAllowlists: {},
    workspaceDevAccess: { ws: port },
  }
}

function status(o: { published?: number | null; pending?: boolean; exists?: boolean } = {}): SandboxStatus {
  return {
    workspaceSlug: 'ws',
    eligibility: { ok: true, baseBranch: 'main', warnings: [] },
    exists: o.exists ?? true,
    container: 'stopped',
    worktree: 'ready',
    session: { state: 'idle', agentId: null, permissionMode: null, networkMode: null, lastExit: null },
    git: null,
    recreatePending: o.pending ?? false,
    recreatePlan: null,
    containers: {},
    agentReadiness: {},
    recreatePlans: [],
    channel: 'none',
    publishedCdpPort: o.published ?? null,
  }
}

function setup(port: number | null, st: SandboxStatus): void {
  api.getEnvironment.mockResolvedValue(ok(ENV_READY))
  api.getSettings.mockResolvedValue(ok(settings(port)))
  api.getSummaries.mockResolvedValue(ok({}))
  api.getStatus.mockResolvedValue(ok(st))
  api.getBlocked.mockResolvedValue(ok([]))
  useWorkspaceStore.setState({ workspaces: [WS] })
  useSandboxStore.setState({
    environment: ENV_READY,
    settings: settings(port),
    status: { ws: st },
    summaries: {},
    build: { running: false, lines: [], phase: 'idle', requestedFor: null },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

const section = () => screen.getByRole('region', { name: 'Dev app access' })

describe('Dev app access section', () => {
  it('is off by default and says it applies to Claude sessions', () => {
    setup(null, status())
    render(<SandboxSettingsPanel />)
    expect(within(section()).getByRole('checkbox', { name: DEV_ACCESS_TOGGLE })).not.toBeChecked()
    expect(section()).toHaveTextContent(DEV_ACCESS_APPLIES)
    expect(section()).toHaveTextContent(DEV_ACCESS_HELP)
    expect(section()).toHaveTextContent('Anything on this computer can then run commands in this sandbox and use your Claude sign-in.')
    expect(section()).toHaveTextContent('treat what it shows as coming from the agent')
  })

  it('turning it on sends only the workspace and a boolean, never a port', async () => {
    setup(null, status())
    api.updateSettings.mockResolvedValue(ok(settings(27000)))
    render(<SandboxSettingsPanel />)
    await userEvent.click(within(section()).getByRole('checkbox', { name: DEV_ACCESS_TOGGLE }))
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ workspaceDevAccess: { workspaceSlug: 'ws', enabled: true } })
  })

  it('turning it off sends enabled: false', async () => {
    setup(27000, status({ published: 27000 }))
    api.updateSettings.mockResolvedValue(ok(settings(null)))
    render(<SandboxSettingsPanel />)
    await userEvent.click(within(section()).getByRole('checkbox', { name: DEV_ACCESS_TOGGLE }))
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ workspaceDevAccess: { workspaceSlug: 'ws', enabled: false } })
  })

  it('published: shows the route, the copy button and the chrome://inspect steps, with nothing pending', () => {
    setup(27000, status({ published: 27000 }))
    render(<SandboxSettingsPanel />)
    expect(section()).toHaveTextContent('This computer 127.0.0.1:27000 → dev app port 9222 in the sandbox. Applies to Claude sessions in this workspace.')
    expect(within(section()).getByRole('button', { name: 'Copy command 127.0.0.1:27000' })).toBeInTheDocument()
    expect(section()).toHaveTextContent('chrome://inspect → Configure… → add 127.0.0.1:27000.')
    expect(section()).not.toHaveTextContent(DEV_ACCESS_NEXT_START)
    expect(within(section()).queryByRole('button', { name: /Recreate/ })).toBeNull()
  })

  it('on but not yet published: says when it takes effect and offers Recreate now', () => {
    setup(27000, status({ published: null, pending: true }))
    render(<SandboxSettingsPanel />)
    expect(within(section()).getByText(DEV_ACCESS_NEXT_START)).toBeInTheDocument()
    expect(within(section()).getByRole('button', { name: 'Recreate now for My Workspace' })).toBeEnabled()
  })

  it('off while still published: says the port stays open until the next start', () => {
    setup(null, status({ published: 27000, pending: true }))
    render(<SandboxSettingsPanel />)
    const line = 'Off. 127.0.0.1:27000 stays open until your Claude session next starts.'
    expect(within(section()).getByRole('status')).toHaveTextContent(line)
    // One merged sentence: no separate "still open" line next to it.
    expect(section().textContent?.split('127.0.0.1:27000').length).toBe(2)
    expect(within(section()).getByRole('button', { name: 'Recreate now for My Workspace' })).toBeInTheDocument()
  })

  it('Recreate now is the primary action only while the port is open with the toggle off', () => {
    setup(null, status({ published: 27000, pending: true }))
    const { unmount } = render(<SandboxSettingsPanel />)
    expect(within(section()).getByRole('button', { name: 'Recreate now for My Workspace' })).toHaveClass('font-semibold')
    unmount()
    setup(27000, status({ published: null, pending: true }))
    render(<SandboxSettingsPanel />)
    expect(within(section()).getByRole('button', { name: 'Recreate now for My Workspace' })).not.toHaveClass('font-semibold')
  })

  it('gives routine agent use the in-session launcher, not the host port', () => {
    setup(27000, status())
    render(<SandboxSettingsPanel />)
    expect(section()).toHaveTextContent(DEV_ACCESS_ROUTINE_USE)
    expect(DEV_ACCESS_ROUTINE_USE).toContain('make dev-sandbox')
    expect(DEV_ACCESS_ROUTINE_USE).toContain('co_dev_shot.mjs')
  })

  it('never says CDP in the section', () => {
    setup(27000, status({ published: 27000 }))
    render(<SandboxSettingsPanel />)
    expect(section().textContent).not.toMatch(/CDP/i)
  })

  it('without a container there is nothing to recreate', () => {
    setup(27000, status({ exists: false }))
    render(<SandboxSettingsPanel />)
    expect(within(section()).getByText(DEV_ACCESS_NEXT_START)).toBeInTheDocument()
    expect(within(section()).queryByRole('button', { name: /Recreate/ })).toBeNull()
  })

  it('shows Recreate now even when the status has not flagged the change itself', () => {
    setup(27000, status({ published: null, pending: false }))
    render(<SandboxSettingsPanel />)
    expect(within(section()).getByRole('button', { name: 'Recreate now for My Workspace' })).toBeInTheDocument()
  })

  it('links the security warning to the toggle with aria-describedby', () => {
    setup(null, status())
    render(<SandboxSettingsPanel />)
    const toggle = within(section()).getByRole('checkbox', { name: DEV_ACCESS_TOGGLE })
    expect(toggle).toHaveAccessibleDescription(DEV_ACCESS_HELP)
  })

  it('keeps keyboard focus on the toggle while a change is in flight, and ignores a second change', async () => {
    setup(null, status())
    let resolve: (v: unknown) => void = () => undefined
    api.updateSettings.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<SandboxSettingsPanel />)
    const toggle = within(section()).getByRole('checkbox', { name: DEV_ACCESS_TOGGLE })
    toggle.focus()

    await userEvent.keyboard(' ')
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard(' ')
    expect(api.updateSettings).toHaveBeenCalledTimes(1)

    resolve(ok(settings(27000)))
    await vi.waitFor(() => expect(toggle).toHaveAttribute('aria-disabled', 'false'))
    expect(toggle).toHaveFocus()
  })

  it('shows the pending line before the route steps when on but not yet published', () => {
    setup(27000, status({ published: null, pending: true }))
    render(<SandboxSettingsPanel />)
    const next = within(section()).getByText(DEV_ACCESS_NEXT_START)
    const route = within(section()).getByText(/This computer 127\.0\.0\.1:27000/)
    expect(next.compareDocumentPosition(route) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the status region mounted, empty when nothing is pending', () => {
    setup(27000, status({ published: 27000 }))
    render(<SandboxSettingsPanel />)
    const [region] = within(section()).getAllByRole('status')
    expect(region).toBeEmptyDOMElement()
  })

  it('reports a failed change', async () => {
    setup(null, status())
    api.updateSettings.mockResolvedValue({ data: null, error: { code: 'INTERNAL_ERROR', message: 'x' } })
    render(<SandboxSettingsPanel />)
    await userEvent.click(within(section()).getByRole('checkbox', { name: DEV_ACCESS_TOGGLE }))
    expect(await within(section()).findByRole('alert')).toHaveTextContent(DEV_ACCESS_SAVE_FAILED)
  })
})

describe('RecreateDialog CDP wording', () => {
  function plan(overrides: Partial<RecreatePlan> = {}): RecreatePlan {
    return { reason: 'port', specHash: HASH, newHostMounts: [], removedHostMounts: [], agentId: 'claude', ...overrides }
  }

  function open(p: RecreatePlan, port: number | null, newPort = false): void {
    useSandboxStore.setState({ settings: settings(port) })
    render(<RecreateDialog slug="ws" plan={p} newPort={newPort} onRecreated={vi.fn()} onCancel={vi.fn()} />)
  }

  it('enable only: the CDP sentence replaces the channel-port reason', () => {
    open(plan({ devCdpChange: 'enabled' }), 27000)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Dev app debug port on 127.0.0.1:27000. Anything on this computer can control the dev app and run commands in this sandbox.')
    expect(dialog).not.toHaveTextContent(RECREATE_REASON_COPY.port)
  })

  it('disable only: says the port is closed', () => {
    open(plan({ devCdpChange: 'disabled' }), null)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Dev app debug port closed.')
    expect(dialog).not.toHaveTextContent(RECREATE_REASON_COPY.port)
  })

  it('with other changes the CDP line is added to the existing reason', () => {
    open(plan({ reason: 'image', devCdpChange: 'enabled' }), 27000)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent(RECREATE_REASON_COPY.image)
    expect(dialog).toHaveTextContent('Dev app debug port on 127.0.0.1:27000.')
  })

  it('a new channel port keeps its own reason next to the CDP line', () => {
    open(plan({ devCdpChange: 'enabled' }), 27000, true)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent(RECREATE_REASON_COPY.port)
    expect(dialog).toHaveTextContent('Dev app debug port on 127.0.0.1:27000.')
  })

  it('a plan without a CDP change reads as before', () => {
    open(plan(), null)
    expect(screen.getByRole('alertdialog')).toHaveTextContent(RECREATE_REASON_COPY.port)
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('Dev app debug port')
  })
})

describe('Debug port open indicator', () => {
  it('shows whenever the container publishes a port, even with the toggle off', () => {
    setup(null, status({ published: 27000 }))
    render(<SandboxActions slug="ws" />)
    expect(screen.getByText('Debug port open: 127.0.0.1:27000')).toBeInTheDocument()
  })

  it('is absent when no port is published', () => {
    setup(27000, status({ published: null }))
    const { container } = render(<SandboxActions slug="ws" />)
    expect(screen.queryByText(/Debug port open/)).toBeNull()
    expect(container.textContent).not.toMatch(/CDP/i)
  })

  it('stays out of the delete-only and recreate-only rows', () => {
    setup(null, status({ published: 27000 }))
    render(<SandboxActions slug="ws" deleteOnly />)
    render(<SandboxActions slug="ws" recreateOnly forceRecreate />)
    expect(screen.queryByText(/Debug port open/)).toBeNull()
  })
})
