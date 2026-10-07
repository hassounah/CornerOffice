import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

// ---------------------------------------------------------------------------
// TerminalPanel — the PTY must receive the fitted size once it exists (#0033).
// xterm, its addons and FitAddon are faked; the fake FitAddon derives its
// dimensions from a test-controlled container size and cell size.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => ({
  size: { w: 1200, h: 700 },
  cell: { w: 10, h: 20 },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    private resizeListeners: Array<(size: { cols: number; rows: number }) => void> = []
    loadAddon(addon: { activate?: (t: Terminal) => void }) {
      addon.activate?.(this)
    }
    open() {}
    write(_data: string, cb?: () => void) {
      cb?.()
    }
    onData() {
      return { dispose: vi.fn() }
    }
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListeners.push(listener)
      return { dispose: vi.fn() }
    }
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return
      this.cols = cols
      this.rows = rows
      this.resizeListeners.forEach((l) => l({ cols, rows }))
    }
    focus() {}
    dispose() {}
    scrollToBottom() {}
  }
  return { Terminal }
})
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { dispose() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('../../../renderer/components/terminal/FitAddon', () => ({
  FitAddon: class {
    private terminal: { resize(cols: number, rows: number): void } | undefined
    activate(terminal: { resize(cols: number, rows: number): void }) {
      this.terminal = terminal
    }
    dispose() {}
    fit(): boolean {
      if (!this.terminal || fake.size.w === 0 || fake.size.h === 0) return false
      this.terminal.resize(Math.floor(fake.size.w / fake.cell.w), Math.floor(fake.size.h / fake.cell.h))
      return true
    }
  },
}))
vi.mock('../../../renderer/components/terminal/ShimmerOverlay', () => ({
  ShimmerOverlay: () => null,
}))
vi.mock('../../../renderer/utils/code-explorer-nav', () => ({ useOpenCodeExplorer: () => vi.fn() }))

import { TerminalPanel } from '../../../renderer/components/terminal/TerminalPanel'
import { TerminalOverlay } from '../../../renderer/components/terminal/TerminalOverlay'
import { useTerminalStore } from '../../../renderer/stores/terminal-store'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import type { SandboxStatus } from '@main/types/sandbox'

const resize = vi.fn()
const getScrollback = vi.fn()
const roCallbacks: Array<() => void> = []

Object.defineProperty(window, 'cornerOffice', {
  value: {
    sandbox: {},
    terminal: { resize, getScrollback, write: vi.fn() },
    shell: { openExternal: vi.fn() },
    on: vi.fn(() => vi.fn()),
  },
  writable: true,
  configurable: true,
})

function fireResizeObservers(): void {
  act(() => {
    roCallbacks.forEach((cb) => cb())
  })
}

function setContainerSize(w: number, h: number): void {
  fake.size = { w, h }
}

beforeEach(() => {
  vi.useFakeTimers()
  resize.mockReset()
  resize.mockResolvedValue({ success: true })
  getScrollback.mockReset()
  getScrollback.mockResolvedValue({ data: { scrollback: '' } })
  roCallbacks.length = 0
  fake.size = { w: 1200, h: 700 }
  fake.cell = { w: 10, h: 20 }
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      roCallbacks.push(() => callback([], this as unknown as ResizeObserver))
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  vi.useRealTimers()
  delete (document as { fonts?: unknown }).fonts
})

describe('TerminalPanel PTY size', () => {
  it('sends the container size once when the PTY becomes ready', () => {
    const { rerender } = render(<TerminalPanel workspaceSlug="ws" ptyReady={false} />)
    expect(resize).not.toHaveBeenCalled()

    rerender(<TerminalPanel workspaceSlug="ws" ptyReady />)
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith('ws', 120, 35)
  })

  it('sends the size even when the fit equals xterm default 80x24', () => {
    setContainerSize(800, 480)
    const { rerender } = render(<TerminalPanel workspaceSlug="ws" ptyReady={false} />)
    expect(resize).not.toHaveBeenCalled()

    rerender(<TerminalPanel workspaceSlug="ws" ptyReady />)
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith('ws', 80, 24)
  })

  it('fits immediately on the first non-zero container size', () => {
    setContainerSize(0, 0)
    render(<TerminalPanel workspaceSlug="ws" ptyReady />)
    expect(resize).not.toHaveBeenCalled()

    setContainerSize(1000, 600)
    fireResizeObservers()
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith('ws', 100, 30)
  })

  it('debounces later container resizes by 200 ms', () => {
    render(<TerminalPanel workspaceSlug="ws" ptyReady />)
    expect(resize).toHaveBeenCalledTimes(1)
    resize.mockClear()

    setContainerSize(1000, 600)
    fireResizeObservers()
    fireResizeObservers()
    act(() => { vi.advanceTimersByTime(199) })
    expect(resize).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(1) })
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith('ws', 100, 30)
  })

  it('refits when fonts are ready', async () => {
    let resolveFonts: () => void = () => {}
    const ready = new Promise<void>((resolve) => { resolveFonts = resolve })
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true })

    render(<TerminalPanel workspaceSlug="ws" ptyReady />)
    expect(resize).toHaveBeenCalledWith('ws', 120, 35)
    resize.mockClear()

    fake.cell = { w: 12, h: 20 }
    await act(async () => {
      resolveFonts()
      await ready
    })
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith('ws', 100, 35)
  })

  it('does not refit after unmount if fonts resolve late', async () => {
    let resolveFonts: () => void = () => {}
    const ready = new Promise<void>((resolve) => { resolveFonts = resolve })
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true })

    const { unmount } = render(<TerminalPanel workspaceSlug="ws" ptyReady />)
    resize.mockClear()
    unmount()

    fake.cell = { w: 12, h: 20 }
    await act(async () => {
      resolveFonts()
      await ready
    })
    expect(resize).not.toHaveBeenCalled()
  })

  it('on remount with scrollback sends exactly one resize and fires onReady', async () => {
    getScrollback.mockResolvedValue({ data: { scrollback: 'previous output\r\n' } })
    const onReady = vi.fn()
    render(<TerminalPanel workspaceSlug="ws" ptyReady onReady={onReady} />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith('ws', 120, 35)
    expect(onReady).toHaveBeenCalledTimes(1)
  })
})

function runningStatus(): SandboxStatus {
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
  }
}

describe('TerminalOverlay passes ptyReady for every session type', () => {
  it.each([
    ['host', 'ws', {}],
    ['sandbox', 'ws', { ws: 'sandbox' as const }],
    ['shell', 'shell:market', {}],
  ])('%s session sends the size when it turns running', (_label, key, sessionKind) => {
    useTerminalStore.setState({ sessions: { [key]: 'starting' }, overlayVisible: { [key]: true }, sessionKind })
    useSandboxStore.setState({ status: { ws: runningStatus() }, environment: null, blocked: {}, dismissedExit: {} })

    render(<TerminalOverlay workspaceSlug={key} workspaceName="Name" onHide={vi.fn()} />)
    expect(resize).not.toHaveBeenCalled()

    act(() => {
      useTerminalStore.setState({ sessions: { [key]: 'running' } })
    })
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith(key, 120, 35)
  })
})
