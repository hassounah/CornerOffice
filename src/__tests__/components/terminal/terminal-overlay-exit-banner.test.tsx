import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { assertNoNestedInteractive, expectNoAxeViolations } from '../../helpers/a11y'

// ---------------------------------------------------------------------------
// TerminalOverlay — the exit-127 banner (#0037 C4, UX-M6, BE-M8). xterm is
// mocked; this file is about the banner, its actions and keyboard reach.
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

const retryExited = vi.fn()
const changeAgent = vi.fn()
const BANNER = "`codex` may not be installed: install it with `pnpm add -g @openai/codex`."
const BANNER_TEXT = 'codex may not be installed: install it with pnpm add -g @openai/codex'

Object.defineProperty(window, 'cornerOffice', { value: { sandbox: {}, terminal: {}, on: vi.fn(() => vi.fn()) }, writable: true, configurable: true })

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  retryExited.mockReset()
  changeAgent.mockReset()
  useTerminalStore.setState({
    sessions: { ws: 'none' },
    overlayVisible: { ws: true },
    sessionKind: { ws: 'host' },
    exitBanner: { ws: BANNER },
    retryExited,
    changeAgent,
  })
  useSandboxStore.setState({ status: {}, environment: null, blocked: {}, dismissedExit: {} })
})

const renderOverlay = () => render(<TerminalOverlay workspaceSlug="ws" workspaceName="My Workspace" onHide={vi.fn()} />)

describe('TerminalOverlay exit-127 banner', () => {
  it('is a persistent alert with the agent copy', () => {
    renderOverlay()
    const alert = screen.getByRole('alert')
    // The backticks render as <code>, never as raw characters (UX-M4); the install command has a copy button.
    expect(alert).toHaveTextContent(BANNER_TEXT)
    expect(alert.textContent).not.toContain('`')
    expect(alert.querySelector('code')).toHaveTextContent('codex')
    expect(screen.getByRole('button', { name: 'Copy command pnpm add -g @openai/codex' })).toBeInTheDocument()
  })

  it('is absent without a banner', () => {
    useTerminalStore.setState({ exitBanner: {} })
    renderOverlay()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Retry and Change agent are real buttons inside the alert, and not nested in another control', () => {
    renderOverlay()
    const alert = screen.getByRole('alert')
    expect(alert.querySelectorAll('button')).toHaveLength(3) // Copy (the install command), Retry, Change agent
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Change agent' })).toBeEnabled()
    assertNoNestedInteractive(alert)
  })

  it('has no axe violations with the banner showing', async () => {
    const { container } = renderOverlay()
    await expectNoAxeViolations(container)
  })

  it('moves focus to Retry after the alert has been announced, so the keyboard reaches it', async () => {
    renderOverlay()
    // Not in the same frame as the alert: that would pre-empt its announcement.
    expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveFocus()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus())
  })

  it('describes Retry by the banner text and gives both buttons a visible focus ring', () => {
    renderOverlay()
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).toHaveAccessibleDescription(expect.stringContaining(BANNER_TEXT))
    for (const button of [retry, screen.getByRole('button', { name: 'Change agent' })]) {
      expect(button.className).toContain('focus-visible:outline')
    }
  })

  it('Retry calls the store with the workspace', () => {
    renderOverlay()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retryExited).toHaveBeenCalledWith('ws')
  })

  it('Change agent calls the store with the workspace', () => {
    renderOverlay()
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
    expect(changeAgent).toHaveBeenCalledWith('ws')
  })
})
