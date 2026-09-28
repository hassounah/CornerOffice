import { pathToFileURL } from 'url'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'

// ---------------------------------------------------------------------------
// app-origin.ts — sender/origin verification for code:* IPC (TRD §3.4.1, Sec H-2)
//
// A `file:` URL's `origin` is always the literal string "null", so origin
// comparison is useless for the packaged build. Production instead requires
// an EXACT match against the renderer's own index.html path (hash and query
// stripped, since Preview anchors change `location.hash` and the router is a
// MemoryRouter). Dev compares real origins, since the dev server is served
// over http:.
// ---------------------------------------------------------------------------

export type IsAppOrigin = (url: string) => boolean

export interface IsAppOriginOptions {
  isPackaged: boolean
  rendererIndexPath: string
  devUrl: string
}

function withoutHashAndQuery(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.href
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function makeIsAppOrigin({ isPackaged, rendererIndexPath, devUrl }: IsAppOriginOptions): IsAppOrigin {
  if (isPackaged) {
    const indexHref = pathToFileURL(rendererIndexPath).href
    return (url: string): boolean => withoutHashAndQuery(url) === indexHref
  }
  const devOrigin = originOf(devUrl)
  return (url: string): boolean => devOrigin !== null && originOf(url) === devOrigin
}

/**
 * L3: the call must come from the main frame of the app's own window — never
 * a subframe, a foreign window, or a call with no window/frame at all.
 */
export function isMainFrameSender(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null,
): boolean {
  const win = getMainWindow()
  if (!win) return false
  const senderFrame = event.senderFrame
  if (!senderFrame) return false
  const mainFrame = win.webContents.mainFrame
  if (senderFrame === mainFrame) return true
  return senderFrame.processId === mainFrame.processId && senderFrame.routingId === mainFrame.routingId
}

/**
 * Addendum A1: prevents `will-navigate` to any URL that fails `isAppOrigin`,
 * and denies every `window.open`. Wired in `index.ts` right after the
 * `BrowserWindow` is created (1.20), before `loadURL`/`loadFile`.
 */
export function installNavigationLockdown(webContents: WebContents, isAppOrigin: IsAppOrigin): void {
  webContents.on('will-navigate', (event, url) => {
    if (!isAppOrigin(url)) event.preventDefault()
  })
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/**
 * Sec M-6: a same-document navigation (a MemoryRouter route change, or a
 * `location.hash` update) must never trigger `cb` — only a genuine
 * cross-document main-frame navigation should (e.g. reload, or a lockdown
 * escape attempt that got as far as `will-navigate`).
 */
export function onCrossDocumentMainFrameNavigation(webContents: WebContents, cb: () => void): void {
  webContents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) cb()
  })
}
