import { describe, it, expect, vi } from 'vitest'
import {
  makeIsAppOrigin,
  isMainFrameSender,
  installNavigationLockdown,
  onCrossDocumentMainFrameNavigation,
} from '../main/ipc/app-origin'

// ---------------------------------------------------------------------------
// makeIsAppOrigin — production branch
// ---------------------------------------------------------------------------

describe('makeIsAppOrigin — production (isPackaged: true)', () => {
  const rendererIndexPath = '/app/out/renderer/index.html'
  const isAppOrigin = makeIsAppOrigin({
    isPackaged: true,
    rendererIndexPath,
    devUrl: 'http://localhost:5173',
  })

  it('accepts the exact index URL', () => {
    expect(isAppOrigin('file:///app/out/renderer/index.html')).toBe(true)
  })

  it('accepts the index URL with a hash (Preview anchors, MemoryRouter)', () => {
    expect(isAppOrigin('file:///app/out/renderer/index.html#/workspace/foo')).toBe(true)
  })

  it('accepts the index URL with a query string', () => {
    expect(isAppOrigin('file:///app/out/renderer/index.html?x=1')).toBe(true)
  })

  it('rejects a sibling file in the same directory', () => {
    expect(isAppOrigin('file:///app/out/renderer/other.html')).toBe(false)
  })

  it('rejects an unrelated file: URL', () => {
    expect(isAppOrigin('file:///tmp/evil.html')).toBe(false)
  })

  it('rejects about:blank', () => {
    expect(isAppOrigin('about:blank')).toBe(false)
  })

  it('rejects a data: URL', () => {
    expect(isAppOrigin('data:text/html,<script>alert(1)</script>')).toBe(false)
  })

  it('rejects a devtools: URL', () => {
    expect(isAppOrigin('devtools://devtools/bundled/inspector.html')).toBe(false)
  })

  it('rejects the dev server origin when packaged', () => {
    expect(isAppOrigin('http://localhost:5173')).toBe(false)
  })

  it('rejects a malformed URL rather than throwing', () => {
    expect(isAppOrigin('not a url')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// makeIsAppOrigin — dev branch
// ---------------------------------------------------------------------------

describe('makeIsAppOrigin — dev (isPackaged: false)', () => {
  const isAppOrigin = makeIsAppOrigin({
    isPackaged: false,
    rendererIndexPath: '/app/out/renderer/index.html',
    devUrl: 'http://localhost:5173',
  })

  it('accepts the dev origin', () => {
    expect(isAppOrigin('http://localhost:5173')).toBe(true)
  })

  it('accepts the dev origin with a path and hash', () => {
    expect(isAppOrigin('http://localhost:5173/some/path#/x')).toBe(true)
  })

  it('rejects a different origin (different port)', () => {
    expect(isAppOrigin('http://localhost:5174')).toBe(false)
  })

  it('rejects a different scheme entirely', () => {
    expect(isAppOrigin('file:///app/out/renderer/index.html')).toBe(false)
  })

  it('rejects a malformed URL rather than throwing', () => {
    expect(isAppOrigin('not a url')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isMainFrameSender
// ---------------------------------------------------------------------------

function makeFrame(processId: number, routingId: number) {
  return { processId, routingId, url: 'file:///app/out/renderer/index.html' }
}

describe('isMainFrameSender', () => {
  it('denies when getMainWindow() returns null', () => {
    const event = { senderFrame: makeFrame(1, 1) } as unknown as Electron.IpcMainInvokeEvent
    expect(isMainFrameSender(event, () => null)).toBe(false)
  })

  it('denies when event.senderFrame is null', () => {
    const win = { webContents: { mainFrame: makeFrame(1, 1) } } as unknown as Electron.BrowserWindow
    const event = { senderFrame: null } as unknown as Electron.IpcMainInvokeEvent
    expect(isMainFrameSender(event, () => win)).toBe(false)
  })

  it('accepts the exact same frame object as the main frame', () => {
    const mainFrame = makeFrame(1, 1)
    const win = { webContents: { mainFrame } } as unknown as Electron.BrowserWindow
    const event = { senderFrame: mainFrame } as unknown as Electron.IpcMainInvokeEvent
    expect(isMainFrameSender(event, () => win)).toBe(true)
  })

  it('accepts a different object with the same processId/routingId as the main frame', () => {
    const win = { webContents: { mainFrame: makeFrame(1, 1) } } as unknown as Electron.BrowserWindow
    const event = { senderFrame: makeFrame(1, 1) } as unknown as Electron.IpcMainInvokeEvent
    expect(isMainFrameSender(event, () => win)).toBe(true)
  })

  it('denies a subframe (different routingId)', () => {
    const win = { webContents: { mainFrame: makeFrame(1, 1) } } as unknown as Electron.BrowserWindow
    const event = { senderFrame: makeFrame(1, 2) } as unknown as Electron.IpcMainInvokeEvent
    expect(isMainFrameSender(event, () => win)).toBe(false)
  })

  it('denies a sender from a different process', () => {
    const win = { webContents: { mainFrame: makeFrame(1, 1) } } as unknown as Electron.BrowserWindow
    const event = { senderFrame: makeFrame(2, 1) } as unknown as Electron.IpcMainInvokeEvent
    expect(isMainFrameSender(event, () => win)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// installNavigationLockdown
// ---------------------------------------------------------------------------

function makeMockWebContents() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners[event] ??= []
      listeners[event].push(listener)
    }),
    setWindowOpenHandler: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) listener(...args)
    },
  }
}

describe('installNavigationLockdown', () => {
  it("prevents will-navigate to a URL isAppOrigin rejects", () => {
    const webContents = makeMockWebContents()
    const isAppOrigin = (url: string) => url === 'file:///app/index.html'
    installNavigationLockdown(webContents as unknown as Electron.WebContents, isAppOrigin)

    const preventDefault = vi.fn()
    webContents.emit('will-navigate', { preventDefault }, 'file:///tmp/evil.html')
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('allows will-navigate to the app URL', () => {
    const webContents = makeMockWebContents()
    const isAppOrigin = (url: string) => url === 'file:///app/index.html'
    installNavigationLockdown(webContents as unknown as Electron.WebContents, isAppOrigin)

    const preventDefault = vi.fn()
    webContents.emit('will-navigate', { preventDefault }, 'file:///app/index.html')
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('registers a window-open handler that denies every request', () => {
    const webContents = makeMockWebContents()
    installNavigationLockdown(webContents as unknown as Electron.WebContents, () => true)
    expect(webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = webContents.setWindowOpenHandler.mock.calls[0][0]
    expect(handler()).toEqual({ action: 'deny' })
  })
})

// ---------------------------------------------------------------------------
// onCrossDocumentMainFrameNavigation
// ---------------------------------------------------------------------------

describe('onCrossDocumentMainFrameNavigation', () => {
  it('calls cb for a cross-document main-frame navigation', () => {
    const webContents = makeMockWebContents()
    const cb = vi.fn()
    onCrossDocumentMainFrameNavigation(webContents as unknown as Electron.WebContents, cb)

    webContents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores a same-document navigation (hash/route change)', () => {
    const webContents = makeMockWebContents()
    const cb = vi.fn()
    onCrossDocumentMainFrameNavigation(webContents as unknown as Electron.WebContents, cb)

    webContents.emit('did-start-navigation', {}, 'file:///app/index.html#/x', true, true)
    expect(cb).not.toHaveBeenCalled()
  })

  it('ignores a subframe navigation', () => {
    const webContents = makeMockWebContents()
    const cb = vi.fn()
    onCrossDocumentMainFrameNavigation(webContents as unknown as Electron.WebContents, cb)

    webContents.emit('did-start-navigation', {}, 'file:///app/frame.html', false, false)
    expect(cb).not.toHaveBeenCalled()
  })
})
