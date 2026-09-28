import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from '../../../renderer/components/code/StatusBar'

// ---------------------------------------------------------------------------
// StatusBar — the §3.6.3 wireframe's bottom bar. Pure, prop-driven.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('StatusBar', () => {
  it('renders line and column (1-based)', () => {
    render(<StatusBar line={42} col={7} encoding="utf-8" eol="lf" />)
    expect(screen.getByText('Ln 42, Col 7')).toBeInTheDocument()
  })

  it.each([
    ['utf-8', 'UTF-8'],
    ['utf-8-lossy', 'UTF-8 (lossy)'],
    ['utf-16le', 'UTF-16 LE'],
    ['utf-16be', 'UTF-16 BE'],
  ] as const)('renders the %s encoding as "%s"', (encoding, label) => {
    render(<StatusBar line={1} col={1} encoding={encoding} eol="lf" />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it.each([
    ['lf', 'LF'],
    ['crlf', 'CRLF'],
    ['none', '—'],
    ['mixed', 'Mixed'],
  ] as const)('renders the %s eol as "%s"', (eol, label) => {
    render(<StatusBar line={1} col={1} encoding="utf-8" eol={eol} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('shows the Ctrl+G hint on non-Mac', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' })
    render(<StatusBar line={1} col={1} encoding="utf-8" eol="lf" />)
    expect(screen.getByText('Ctrl+G go to line · F3 next match')).toBeInTheDocument()
  })

  it('shows the ⌘G hint on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    render(<StatusBar line={1} col={1} encoding="utf-8" eol="lf" />)
    expect(screen.getByText('⌘G go to line · F3 next match')).toBeInTheDocument()
  })

  it('marks the · separators aria-hidden', () => {
    const { container } = render(<StatusBar line={1} col={1} encoding="utf-8" eol="lf" />)
    const separators = Array.from(container.querySelectorAll('span')).filter((s) => s.textContent === '·')
    expect(separators.length).toBeGreaterThan(0)
    for (const sep of separators) {
      expect(sep).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
