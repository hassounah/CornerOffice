import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// ---------------------------------------------------------------------------
// TerminalOverlay — the compact sandbox badge in the title bar (#0029 step
// 5.6, TRD §3.15.4). The terminal itself (xterm) is mocked: this file is only
// about what the title bar shows for a sandbox session and a host one.
// ---------------------------------------------------------------------------

vi.mock('../../../renderer/components/terminal/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal-panel" />,
}))
vi.mock('../../../renderer/components/terminal/ShimmerOverlay', () => ({
  ShimmerOverlay: () => null,
}))
vi.mock('../../../renderer/utils/code-explorer-nav', () => ({ useOpenCodeExplorer: () => vi.fn() }))

import { TerminalOverlay } from '../../../renderer/components/terminal/TerminalOverlay'
import { useTerminalStore } from '../../../renderer/stores/terminal-store'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import type { SandboxStatus } from '@main/types/sandbox'

Object.defineProperty(window, 'cornerOffice', { value: { sandbox: {}, terminal: {}, on: vi.fn(() => vi.fn()) }, writable: true, configurable: true })

function runningStatus(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  return {
    workspaceSlug: 'ws',
    eligibility: { ok: true, baseBranch: 'main', warnings: [] },
    exists: true,
    container: 'running',
    worktree: 'ready',
    session: { state: 'running', permissionMode: 'skip', networkMode: 'open', lastExit: null },
    git: { branch: 'feat/a', headShort: 'abc', ahead: 2, dirtyCount: 5, base: 'main' },
    recreatePending: false,
    recreatePlan: null,
    channel: 'unavailable',
    ...overrides,
  }
}

function renderOverlay() {
  return render(<TerminalOverlay workspaceSlug="ws" workspaceName="My Workspace" onHide={vi.fn()} />)
}

beforeEach(() => {
  // jsdom has no ResizeObserver; the overlay watches its parent's size.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  useTerminalStore.setState({ sessions: { ws: 'running' }, overlayVisible: { ws: true }, sessionKind: {} })
  useSandboxStore.setState({ status: { ws: runningStatus() }, environment: null, blocked: {}, dismissedExit: {} })
})

describe('TerminalOverlay focus target', () => {
  it('is a focusable container named by its workspace, so a start can move focus into it', () => {
    renderOverlay()
    const overlay = document.querySelector<HTMLElement>('[data-terminal-overlay="ws"]')
    expect(overlay).not.toBeNull()
    overlay?.focus()
    expect(overlay).toHaveFocus()
  })
})

describe('TerminalOverlay title bar', () => {
  it('shows the compact sandbox badge before End Session / Hide for a sandbox session', () => {
    useTerminalStore.setState({ sessionKind: { ws: 'sandbox' } })
    renderOverlay()

    const badge = screen.getByRole('group', { name: 'Sandbox status' })
    expect(badge).toHaveTextContent('Sandbox · feat/a · +2')
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument()
    // Compact keeps every warning and drops the detail chips.
    expect(badge).toHaveTextContent('Unrestricted network')
    expect(badge).toHaveTextContent('Channel: unavailable')
    expect(badge).not.toHaveTextContent('uncommitted')

    const endSession = screen.getByRole('button', { name: 'End Session' })
    expect(badge.compareDocumentPosition(endSession) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows no sandbox badge for a host session, even if the workspace has a sandbox', () => {
    useTerminalStore.setState({ sessionKind: { ws: 'host' } })
    renderOverlay()
    expect(screen.queryByRole('group', { name: 'Sandbox status' })).toBeNull()
    expect(screen.getByRole('button', { name: 'End Session' })).toBeInTheDocument()
  })

  it('shows no sandbox badge when the session kind is unknown', () => {
    renderOverlay()
    expect(screen.queryByRole('group', { name: 'Sandbox status' })).toBeNull()
  })
})
