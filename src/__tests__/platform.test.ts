import { describe, it, expect, vi, afterEach } from 'vitest'
import { isMac, isLinux } from '../renderer/utils/platform'

// ---------------------------------------------------------------------------
// platform.ts — OS detection for shortcut copy (TRD §2.4 Q7).
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isMac', () => {
  it('is true on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    expect(isMac()).toBe(true)
  })

  it('is false on Windows', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' })
    expect(isMac()).toBe(false)
  })

  it('is false on Linux', () => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'X11; Linux' })
    expect(isMac()).toBe(false)
  })

  it('falls back to userAgent when platform is empty', () => {
    vi.stubGlobal('navigator', { platform: '', userAgent: 'Macintosh' })
    expect(isMac()).toBe(true)
  })
})

describe('isLinux', () => {
  it('is true on Linux', () => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'X11; Linux' })
    expect(isLinux()).toBe(true)
  })

  it('is false on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    expect(isLinux()).toBe(false)
  })

  it('is false on Windows', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' })
    expect(isLinux()).toBe(false)
  })
})
