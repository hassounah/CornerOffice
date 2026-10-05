import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

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

const PARENT_W = 1000
const PARENT_H = 800

beforeEach(() => {
  // jsdom has no ResizeObserver and no layout; the overlay watches its parent's size.
  // Like a browser, observe() delivers an initial observation.
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(PARENT_W)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(PARENT_H)
  useTerminalStore.setState({ sessions: { ws: 'running' }, overlayVisible: { ws: true }, sessionKind: {} })
  useSandboxStore.setState({ status: { ws: runningStatus() }, environment: null, blocked: {}, dismissedExit: {} })
})

const floating = (): HTMLElement => document.querySelector<HTMLElement>('[data-terminal-overlay="ws"]') as HTMLElement
const blocker = (): Element | null => document.querySelector('[style*="z-index: 20"]')

describe('TerminalOverlay bounds', () => {
  it('clamps an oversized persisted windowBounds after mount', () => {
    render(
      <TerminalOverlay
        workspaceSlug="ws"
        workspaceName="My Workspace"
        windowBounds={{ x: 99, y: 99, width: 20, height: 20 }}
        onHide={vi.fn()}
      />,
    )
    // 800x600 minimum on a 1000x800 parent is 80% x 75%; the title bar stays on screen.
    expect(floating().style.width).toBe('80%')
    expect(floating().style.height).toBe('75%')
    expect(floating().style.left).toBe('90%')
    expect(parseFloat(floating().style.top)).toBeLessThan(95)
  })
})

describe('TerminalOverlay drag and resize', () => {
  const grip = (): HTMLElement => screen.getByText('My Workspace').parentElement as HTMLElement

  it('shows the grabbing cursor and the pointer-events blocker during a drag, and neither after mouseup', () => {
    renderOverlay()
    expect(grip().style.cursor).toBe('grab')
    expect(blocker()).toBeNull()

    fireEvent.mouseDown(grip(), { clientX: 10, clientY: 10 })
    expect(grip().style.cursor).toBe('grabbing')
    expect(blocker()).not.toBeNull()

    fireEvent.mouseUp(window)
    expect(grip().style.cursor).toBe('grab')
    expect(blocker()).toBeNull()
  })

  it('keeps the grab cursor but shows the blocker during a resize', () => {
    renderOverlay()
    const handle = floating().firstElementChild as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 10, clientY: 10 })
    expect(grip().style.cursor).toBe('grab')
    expect(blocker()).not.toBeNull()

    fireEvent.mouseUp(window)
    expect(blocker()).toBeNull()
  })
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
