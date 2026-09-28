import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

// ---------------------------------------------------------------------------
// quit-guard.ts — the window-close/app-quit state machine (TRD §3.7.3, L2;
// step 1.20). The renderer side (GlobalListeners' `beforeunload`, already
// wired in step 2.2) is the other half of this contract:
//
// 1. A quit is attempted (tray "Quit", Cmd/Ctrl+Q, the last window closing).
//    Electron fires `before-quit` — `onBeforeQuit()` marks `isQuitting()`
//    true so the window's own `close` handler lets the close proceed
//    instead of hiding to the tray.
// 2. The window closing triggers the renderer's `beforeunload`. If a dirty
//    source exists, the renderer calls `e.preventDefault()`, which Electron
//    surfaces to main as `webContents`'s `will-prevent-unload` —
//    `onWillPreventUnload()` remembers a quit was pending, flips
//    `isQuitting()` back to false (so a stray close attempt in between
//    hides to the tray again, not the reverse), and re-shows the window so
//    the user actually sees the confirm dialog the renderer is about to
//    raise via `queueMicrotask`.
// 3. If the user confirms discarding, the renderer's guard dialog store
//    calls `discard(scope)` (clearing the dirty state that would otherwise
//    re-trigger `beforeunload`) and then invokes `window:resumeClose`.
//    `resumeClose(event)` re-attempts app.quit() (if a quit was pending) or
//    a plain window close (if this was an ordinary close the user
//    confirmed) — this time nothing blocks it.
// 4. Escape hatch (L2): a SECOND tray "Quit" within 5 s of the first calls
//    `app.exit(0)` directly, bypassing `beforeunload` entirely — the user
//    explicitly forced it twice, and this is documented as discarding
//    unsaved edits. `anyDirty()` (dirty-registry.ts, step 2.1) already
//    treats a throwing `isDirty()` as clean, so a buggy dirty source can't
//    make step 1–3 unreachable and force everyone through this hatch.
// ---------------------------------------------------------------------------

const TRAY_QUIT_ESCAPE_WINDOW_MS = 5_000

export interface QuitGuardApp {
  quit: () => void
  exit: (code: number) => void
}

export interface QuitGuardDeps {
  app: QuitGuardApp
  /** The current main window, or null if it doesn't exist / was destroyed —
   *  read fresh on every call, never cached (the window can be recreated). */
  getWindow: () => BrowserWindow | null
  /** Re-shows and focuses the window so the user sees the confirm dialog
   *  the renderer's `beforeunload` handler is about to raise. */
  showAndFocus: () => void
  /** Injected for deterministic tests — `Date.now` in production. */
  now: () => number
}

export interface QuitGuard {
  /** True from `before-quit` until either a `will-prevent-unload` cancels
   *  it or the app actually exits. The window's own `close` handler reads
   *  this instead of hiding to the tray while a real quit is underway. */
  isQuitting: () => boolean
  /** `app.on('before-quit', ...)` handler body. */
  onBeforeQuit: () => void
  /** `webContents.on('will-prevent-unload', ...)` handler body. Never calls
   *  `event.preventDefault()` itself — leaving the unload cancelled is the
   *  intended effect (TRD §3.7.3: "There is no preventDefault, so the
   *  unload is cancelled"). */
  onWillPreventUnload: () => void
  /** `window:resumeClose` IPC handler (Sec L-6: only acts when `event`'s
   *  sender is the current window's own webContents — a foreign sender,
   *  e.g. a devtools or future secondary window, is silently ignored). */
  resumeClose: (event: Pick<IpcMainInvokeEvent, 'sender'>) => void
  /** Tray "Quit" menu item click handler — the L2 escape hatch. */
  onTrayQuit: () => void
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let quitting = false
  let pendingQuit = false
  let lastTrayQuitAt: number | null = null

  function isQuitting(): boolean {
    return quitting
  }

  function onBeforeQuit(): void {
    quitting = true
  }

  function onWillPreventUnload(): void {
    pendingQuit = quitting
    quitting = false
    deps.showAndFocus()
  }

  function resumeClose(event: Pick<IpcMainInvokeEvent, 'sender'>): void {
    const win = deps.getWindow()
    if (!win || event.sender !== win.webContents) return
    if (pendingQuit) {
      pendingQuit = false
      deps.app.quit()
    } else {
      win.close()
    }
  }

  function onTrayQuit(): void {
    const now = deps.now()
    if (lastTrayQuitAt !== null && now - lastTrayQuitAt < TRAY_QUIT_ESCAPE_WINDOW_MS) {
      deps.app.exit(0)
      return
    }
    lastTrayQuitAt = now
    deps.app.quit()
  }

  return { isQuitting, onBeforeQuit, onWillPreventUnload, resumeClose, onTrayQuit }
}
