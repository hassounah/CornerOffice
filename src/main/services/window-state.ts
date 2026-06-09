import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { BrowserWindow } from 'electron'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WindowStateData {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** Minimal screen interface — allows injection of test doubles */
export interface ScreenLike {
  getAllDisplays: () => Array<{ bounds: { x: number; y: number; width: number; height: number } }>
}

const DEFAULT_STATE: WindowStateData = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  maximized: false,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statePath(): string {
  return path.join(os.homedir(), '.corner-office', 'window-state.json')
}

// ---------------------------------------------------------------------------
// WindowStateService
// ---------------------------------------------------------------------------

export class WindowStateService {
  private _screen: ScreenLike | null

  constructor(screen: ScreenLike | null = null) {
    this._screen = screen
  }

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  load(): WindowStateData {
    const sPath = statePath()
    if (!fs.existsSync(sPath)) return { ...DEFAULT_STATE }

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(sPath, 'utf-8'))
    } catch {
      return { ...DEFAULT_STATE }
    }

    if (!this._isValid(raw)) return { ...DEFAULT_STATE }

    const state = raw as WindowStateData
    if (!this._isOnScreen(state)) {
      // Position is off all displays — reset to default, keep size
      return { ...DEFAULT_STATE, width: state.width, height: state.height }
    }

    return state
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  save(win: BrowserWindow): void {
    const isMaximized = win.isMaximized()
    let state: WindowStateData

    if (isMaximized) {
      // Don't save maximized bounds — save last normal bounds instead
      const normalBounds = win.getNormalBounds?.() ?? win.getBounds()
      state = {
        x: normalBounds.x,
        y: normalBounds.y,
        width: normalBounds.width,
        height: normalBounds.height,
        maximized: true,
      }
    } else {
      const bounds = win.getBounds()
      state = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: false,
      }
    }

    const sPath = statePath()
    const tmp = `${sPath}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(tmp, sPath)
    } catch (err) {
      log.warn('[WindowState] Failed to save window state:', err)
    }
  }

  // ---------------------------------------------------------------------------
  // Apply to window
  // ---------------------------------------------------------------------------

  apply(win: BrowserWindow, state: WindowStateData): void {
    win.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height })
    if (state.maximized) {
      win.maximize()
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _isValid(raw: unknown): raw is WindowStateData {
    if (!raw || typeof raw !== 'object') return false
    const r = raw as Record<string, unknown>
    return (
      typeof r.x === 'number' &&
      typeof r.y === 'number' &&
      typeof r.width === 'number' &&
      typeof r.height === 'number' &&
      typeof r.maximized === 'boolean' &&
      r.width > 0 &&
      r.height > 0
    )
  }

  private _isOnScreen(state: WindowStateData): boolean {
    if (!this._screen) return true // can't check without screen — assume valid

    const displays = this._screen.getAllDisplays()
    if (displays.length === 0) return true

    // Check if top-left corner is within any display bounds (with some tolerance)
    const TOLERANCE = 50
    return displays.some((display) => {
      const { x, y, width, height } = display.bounds
      return (
        state.x + TOLERANCE >= x &&
        state.x < x + width - TOLERANCE &&
        state.y + TOLERANCE >= y &&
        state.y < y + height - TOLERANCE
      )
    })
  }
}

export const windowStateService = new WindowStateService()
