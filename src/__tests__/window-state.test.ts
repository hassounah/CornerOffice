import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WindowStateService } from '../main/services/window-state'
import type { WindowStateData } from '../main/services/window-state'

vi.mock('fs')
vi.mock('os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))

import fs from 'fs'
const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

const STATE_PATH = '/home/test/.corner-office/window-state.json'

function makeState(overrides: Partial<WindowStateData> = {}): WindowStateData {
  return {
    x: 100,
    y: 200,
    width: 1280,
    height: 800,
    maximized: false,
    ...overrides,
  }
}

function makeScreen(displays: Array<{ bounds: { x: number; y: number; width: number; height: number } }>) {
  return { getAllDisplays: () => displays }
}

const PRIMARY_DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

describe('WindowStateService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.existsSync = vi.fn().mockReturnValue(false)
    mockFs.readFileSync = vi.fn()
    mockFs.writeFileSync = vi.fn()
    mockFs.renameSync = vi.fn()
  })

  describe('load', () => {
    it('returns defaults when state file does not exist', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      const svc = new WindowStateService(makeScreen([PRIMARY_DISPLAY]))
      const state = svc.load()
      expect(state.width).toBe(1280)
      expect(state.height).toBe(800)
      expect(state.maximized).toBe(false)
    })

    it('returns parsed state when file exists and is valid', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(makeState({ x: 50, y: 75 })))
      const svc = new WindowStateService(makeScreen([PRIMARY_DISPLAY]))
      const state = svc.load()
      expect(state.x).toBe(50)
      expect(state.y).toBe(75)
    })

    it('returns defaults when file is malformed JSON', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue('not-json')
      const svc = new WindowStateService(makeScreen([PRIMARY_DISPLAY]))
      const state = svc.load()
      expect(state.width).toBe(1280)
    })

    it('returns defaults when required fields are missing', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify({ x: 0, y: 0 })) // missing width/height
      const svc = new WindowStateService(makeScreen([PRIMARY_DISPLAY]))
      const state = svc.load()
      expect(state.width).toBe(1280)
    })

    it('resets position (but keeps size) when window is off-screen', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      // Position far off any display
      mockFs.readFileSync = vi.fn().mockReturnValue(
        JSON.stringify(makeState({ x: 9999, y: 9999, width: 1024, height: 768 }))
      )
      const svc = new WindowStateService(makeScreen([PRIMARY_DISPLAY]))
      const state = svc.load()
      expect(state.x).toBe(0)
      expect(state.y).toBe(0)
      expect(state.width).toBe(1024) // size preserved
      expect(state.height).toBe(768)
    })

    it('accepts position on a secondary display', () => {
      const secondDisplay = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(
        JSON.stringify(makeState({ x: 2000, y: 100 }))
      )
      const svc = new WindowStateService(makeScreen([PRIMARY_DISPLAY, secondDisplay]))
      const state = svc.load()
      expect(state.x).toBe(2000)
    })

    it('returns defaults when no screen is provided (cannot validate)', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readFileSync = vi.fn().mockReturnValue(JSON.stringify(makeState({ x: 50, y: 50 })))
      const svc = new WindowStateService(null)
      const state = svc.load()
      expect(state.x).toBe(50) // no screen validation — accepts as-is
    })
  })

  describe('save', () => {
    function makeMockWindow(overrides: Partial<{
      isMaximized: boolean
      bounds: { x: number; y: number; width: number; height: number }
      normalBounds: { x: number; y: number; width: number; height: number }
    }> = {}) {
      const bounds = overrides.bounds ?? { x: 100, y: 200, width: 1280, height: 800 }
      return {
        isMaximized: () => overrides.isMaximized ?? false,
        getBounds: () => bounds,
        getNormalBounds: overrides.normalBounds ? () => overrides.normalBounds! : undefined,
      }
    }

    it('saves current bounds to disk', () => {
      const svc = new WindowStateService(null)
      const win = makeMockWindow({ bounds: { x: 50, y: 75, width: 1024, height: 768 } })
      svc.save(win as never)
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        `${STATE_PATH}.tmp`,
        expect.stringContaining('"x": 50'),
        expect.objectContaining({ mode: 0o600 })
      )
      expect(mockFs.renameSync).toHaveBeenCalledWith(`${STATE_PATH}.tmp`, STATE_PATH)
    })

    it('saves maximized: true when window is maximized', () => {
      const svc = new WindowStateService(null)
      const win = makeMockWindow({
        isMaximized: true,
        normalBounds: { x: 50, y: 50, width: 1024, height: 768 },
      })
      svc.save(win as never)
      const written = (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
      const parsed = JSON.parse(written) as WindowStateData
      expect(parsed.maximized).toBe(true)
    })

    it('saves normal bounds (not maximized bounds) when maximized', () => {
      const svc = new WindowStateService(null)
      const win = makeMockWindow({
        isMaximized: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 }, // full-screen maximized bounds
        normalBounds: { x: 50, y: 50, width: 1024, height: 768 },
      })
      svc.save(win as never)
      const written = (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
      const parsed = JSON.parse(written) as WindowStateData
      expect(parsed.width).toBe(1024) // normal (not maximized) size
    })

    it('does not throw when write fails', () => {
      mockFs.writeFileSync = vi.fn().mockImplementation(() => { throw new Error('disk full') })
      const svc = new WindowStateService(null)
      const win = makeMockWindow()
      expect(() => svc.save(win as never)).not.toThrow()
    })
  })

  describe('apply', () => {
    it('calls setBounds and maximize when state.maximized is true', () => {
      const win = { setBounds: vi.fn(), maximize: vi.fn() }
      const svc = new WindowStateService(null)
      svc.apply(win as never, makeState({ maximized: true }))
      expect(win.setBounds).toHaveBeenCalled()
      expect(win.maximize).toHaveBeenCalled()
    })

    it('calls setBounds only when not maximized', () => {
      const win = { setBounds: vi.fn(), maximize: vi.fn() }
      const svc = new WindowStateService(null)
      svc.apply(win as never, makeState({ maximized: false }))
      expect(win.setBounds).toHaveBeenCalled()
      expect(win.maximize).not.toHaveBeenCalled()
    })
  })
})
