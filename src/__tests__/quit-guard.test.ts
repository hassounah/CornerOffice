import { describe, it, expect, vi } from 'vitest'
import { createQuitGuard } from '../main/services/quit-guard'
import type { QuitGuardDeps } from '../main/services/quit-guard'

// ---------------------------------------------------------------------------
// quit-guard.ts — the window-close/app-quit state machine (TRD §3.7.3, L2).
// No real Electron module is touched here: `app`/`getWindow`/`showAndFocus`/
// `now` are all injected, exactly as createQuitGuard's own signature
// requires, so this exercises the real state machine deterministically.
// ---------------------------------------------------------------------------

function makeWebContents(id: string): { id: string } {
  return { id }
}

function makeDeps(overrides: Partial<QuitGuardDeps> = {}): {
  deps: QuitGuardDeps
  quit: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  showAndFocus: ReturnType<typeof vi.fn>
  webContents: { id: string }
  clock: { value: number }
} {
  const quit = vi.fn()
  const exit = vi.fn()
  const close = vi.fn()
  const showAndFocus = vi.fn()
  const webContents = makeWebContents('main')
  const clock = { value: 0 }
  const win = { webContents, close } as unknown as import('electron').BrowserWindow

  const deps: QuitGuardDeps = {
    app: { quit, exit },
    getWindow: () => win,
    showAndFocus,
    now: () => clock.value,
    ...overrides,
  }
  return { deps, quit, exit, close, showAndFocus, webContents, clock }
}

describe('quit-guard — isQuitting / onBeforeQuit', () => {
  it('starts not quitting', () => {
    const { deps } = makeDeps()
    const guard = createQuitGuard(deps)
    expect(guard.isQuitting()).toBe(false)
  })

  it('onBeforeQuit sets isQuitting to true', () => {
    const { deps } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onBeforeQuit()
    expect(guard.isQuitting()).toBe(true)
  })
})

describe('quit-guard — onWillPreventUnload', () => {
  it('flips isQuitting back to false and re-shows the window', () => {
    const { deps, showAndFocus } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onBeforeQuit()
    guard.onWillPreventUnload()
    expect(guard.isQuitting()).toBe(false)
    expect(showAndFocus).toHaveBeenCalledTimes(1)
  })

  it('remembers a quit was pending when isQuitting was true', () => {
    const { deps, quit, close } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onBeforeQuit() // a real quit is underway
    guard.onWillPreventUnload() // beforeunload blocked it

    guard.resumeClose({ sender: deps.getWindow()!.webContents })
    expect(quit).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })

  it('does NOT mark a pending quit when isQuitting was already false (an ordinary window close, not a quit)', () => {
    const { deps, quit, close } = makeDeps()
    const guard = createQuitGuard(deps)
    // No onBeforeQuit() call — this is a plain close, not a real app quit.
    guard.onWillPreventUnload()

    guard.resumeClose({ sender: deps.getWindow()!.webContents })
    expect(close).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('quit-guard — resumeClose (Sec L-6 sender check)', () => {
  it('ignores an event whose sender is not the current window\'s webContents', () => {
    const { deps, quit, close } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onBeforeQuit()
    guard.onWillPreventUnload()

    guard.resumeClose({ sender: makeWebContents('foreign') as unknown as import('electron').WebContents })
    expect(quit).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('ignores the call entirely when there is no current window', () => {
    const { deps, quit, close } = makeDeps({ getWindow: () => null })
    const guard = createQuitGuard(deps)
    expect(() => guard.resumeClose({ sender: makeWebContents('main') as unknown as import('electron').WebContents })).not.toThrow()
    expect(quit).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('a plain resumeClose with no prior will-prevent-unload just closes the window', () => {
    const { deps, quit, close } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.resumeClose({ sender: deps.getWindow()!.webContents })
    expect(close).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
  })

  it('consumes the pending-quit flag: a second resumeClose falls through to close(), not quit() again', () => {
    const { deps, quit, close } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onBeforeQuit()
    guard.onWillPreventUnload()

    guard.resumeClose({ sender: deps.getWindow()!.webContents })
    guard.resumeClose({ sender: deps.getWindow()!.webContents })

    expect(quit).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('quit-guard — onTrayQuit (L2 escape hatch)', () => {
  it('a single tray Quit calls app.quit(), not app.exit()', () => {
    const { deps, quit, exit } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onTrayQuit()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('a second tray Quit within 5s calls app.exit(0) directly, bypassing quit()', () => {
    const { deps, quit, exit, clock } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onTrayQuit()
    clock.value += 4_999
    guard.onTrayQuit()

    expect(quit).toHaveBeenCalledTimes(1) // only the first call
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('a second tray Quit at exactly 5s or later is treated as a fresh first click (calls quit(), not exit())', () => {
    const { deps, quit, exit, clock } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onTrayQuit()
    clock.value += 5_000
    guard.onTrayQuit()

    expect(quit).toHaveBeenCalledTimes(2)
    expect(exit).not.toHaveBeenCalled()
  })

  it('a third click right after the escape-hatch exit still calls exit() again (each click within 5s of the last one escalates)', () => {
    const { deps, exit, clock } = makeDeps()
    const guard = createQuitGuard(deps)
    guard.onTrayQuit()
    clock.value += 1_000
    guard.onTrayQuit() // exit() — escape hatch fires
    clock.value += 1_000
    guard.onTrayQuit() // still within 5s of the (still-recorded) first click's timestamp

    expect(exit).toHaveBeenCalledTimes(2)
  })
})
