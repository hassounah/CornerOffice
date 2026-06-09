import { describe, it, expect, vi, beforeAll } from 'vitest'

// ---------------------------------------------------------------------------
// Security: BrowserWindow webPreferences + CSP + single-instance lock
// ---------------------------------------------------------------------------
// We import src/main/index.ts after mocking Electron to verify all security
// flags without launching a real Chromium process.
// ---------------------------------------------------------------------------

const capturedPrefs: { webPreferences?: Record<string, unknown> } = {}
const capturedCSPHeaders: string[] = []

vi.mock('electron', () => {
  const webContents = {
    on: vi.fn((_event: string, cb: () => void) => {
      // Trigger did-finish-load immediately so main:ready is exercised
      if (_event === 'did-finish-load') cb()
    }),
    send: vi.fn(),
    openDevTools: vi.fn(),
  }

  const win = {
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    on: vi.fn(),
    isMinimized: vi.fn().mockReturnValue(false),
    isVisible: vi.fn().mockReturnValue(true),
    isMaximized: vi.fn().mockReturnValue(false),
    maximize: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    getNormalBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    setBounds: vi.fn(),
    webContents,
  }

  const onHeadersReceived = vi.fn(
    (cb: (details: unknown, callback: (opts: { responseHeaders: Record<string, string[]> }) => void) => void) => {
      cb({ responseHeaders: {} }, (opts) => {
        const csp = opts.responseHeaders['Content-Security-Policy']
        if (csp) capturedCSPHeaders.push(...csp)
      })
    }
  )

  const BrowserWindow = vi.fn().mockImplementation(function (this: unknown, opts: { webPreferences?: Record<string, unknown> }) {
    capturedPrefs.webPreferences = opts.webPreferences
    return win
  }) as unknown as ReturnType<typeof vi.fn> & { getFocusedWindow: ReturnType<typeof vi.fn> }
  BrowserWindow.getFocusedWindow = vi.fn().mockReturnValue(win)

  const app = {
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    quit: vi.fn(),
    whenReady: vi.fn().mockReturnValue(
      new Promise<void>((resolve) => resolve())
    ),
    on: vi.fn(),
  }

  const session = {
    defaultSession: {
      webRequest: { onHeadersReceived },
    },
  }

  const ipcMain = {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }

  const Tray = vi.fn().mockImplementation(function () {
    return {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
    }
  })

  const Menu = {
    buildFromTemplate: vi.fn().mockReturnValue({}),
    setApplicationMenu: vi.fn(),
  }

  const nativeImage = {
    createFromPath: vi.fn().mockReturnValue({ resize: vi.fn().mockReturnValue({}) }),
    createEmpty: vi.fn().mockReturnValue({}),
  }

  const screen = {
    getAllDisplays: vi.fn().mockReturnValue([
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]),
  }

  const Notification = vi.fn().mockImplementation(function () {
    return { show: vi.fn() }
  }) as unknown as ReturnType<typeof vi.fn> & { isSupported: ReturnType<typeof vi.fn> }
  Notification.isSupported = vi.fn().mockReturnValue(false)

  return { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, screen, Notification }
})

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}))

vi.mock('os', () => ({
  default: { homedir: vi.fn().mockReturnValue('/home/test') },
  homedir: vi.fn().mockReturnValue('/home/test'),
}))

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return { ...actual, default: actual }
})

// Import the main module to trigger initialization (mocks are already hoisted)
beforeAll(async () => {
  await import('../main/index')
})

describe('Main process security hardening', () => {
  it('enforces nodeIntegration: false', () => {
    expect(capturedPrefs.webPreferences?.nodeIntegration).toBe(false)
  })

  it('enforces contextIsolation: true', () => {
    expect(capturedPrefs.webPreferences?.contextIsolation).toBe(true)
  })

  it('enforces sandbox: true', () => {
    expect(capturedPrefs.webPreferences?.sandbox).toBe(true)
  })

  it('enforces webviewTag: false', () => {
    expect(capturedPrefs.webPreferences?.webviewTag).toBe(false)
  })

  it('enforces allowRunningInsecureContent: false', () => {
    expect(capturedPrefs.webPreferences?.allowRunningInsecureContent).toBe(false)
  })

  it('enforces webSecurity: true', () => {
    expect(capturedPrefs.webPreferences?.webSecurity).toBe(true)
  })

  it('sets preload path pointing to preload/index.js', () => {
    expect(capturedPrefs.webPreferences?.preload).toMatch(/preload[/\\]index\.js$/)
  })

  it('enforces CSP with frame-src none', () => {
    expect(capturedCSPHeaders.some((h) => h.includes("frame-src 'none'"))).toBe(true)
  })

  it('enforces CSP with object-src none', () => {
    expect(capturedCSPHeaders.some((h) => h.includes("object-src 'none'"))).toBe(true)
  })

  it('enforces CSP with base-uri self', () => {
    expect(capturedCSPHeaders.some((h) => h.includes("base-uri 'self'"))).toBe(true)
  })

  it('enforces CSP with form-action none', () => {
    expect(capturedCSPHeaders.some((h) => h.includes("form-action 'none'"))).toBe(true)
  })

  it('enforces CSP with connect-src none', () => {
    expect(capturedCSPHeaders.some((h) => h.includes("connect-src 'none'"))).toBe(true)
  })

  it('requests single-instance lock', async () => {
    const { app } = await import('electron')
    expect(app.requestSingleInstanceLock).toHaveBeenCalled()
  })

  it('registers second-instance handler', async () => {
    const { app } = await import('electron')
    expect(app.on).toHaveBeenCalledWith('second-instance', expect.any(Function))
  })
})

// ---------------------------------------------------------------------------
// Security: Preload channel whitelist (logic only — no contextBridge needed)
// ---------------------------------------------------------------------------
// Import the real whitelist from preload to prevent test/production drift.
// ---------------------------------------------------------------------------

import { ALLOWED_PUSH_CHANNELS, isAllowedChannel } from '../preload/api'

describe('Preload channel whitelist', () => {
  it('allows all whitelisted channels', () => {
    for (const ch of ALLOWED_PUSH_CHANNELS) {
      expect(isAllowedChannel(ch)).toBe(true)
    }
  })

  it('rejects non-whitelisted channels', () => {
    const blocked = ['arbitrary', 'workspace:delete', 'shell:exec', 'fs:read', '', 'main:ready:extra', '../../../evil']
    for (const ch of blocked) {
      expect(isAllowedChannel(ch)).toBe(false)
    }
  })

  it('whitelist has exactly 16 entries', () => {
    expect(ALLOWED_PUSH_CHANNELS).toHaveLength(16)
  })

  it('includes notification:clicked channel', () => {
    expect(ALLOWED_PUSH_CHANNELS).toContain('notification:clicked')
  })
})
