import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WindowTitleBar } from '../../../renderer/components/layout/WindowTitleBar'

function installApi(profile: { name: string; home: string } | null, devRealData = false): void {
  Object.defineProperty(window, 'cornerOffice', {
    configurable: true,
    value: {
      profile,
      devRealData,
      windowControls: {
        minimize: vi.fn(),
        maximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false),
      },
    },
  })
}

describe('WindowTitleBar profile badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'cornerOffice')
  })

  it('renders no badge in the default profile', () => {
    installApi(null)
    render(<WindowTitleBar />)
    expect(screen.queryByLabelText(/^Profile /)).toBeNull()
  })

  it('renders the profile name with the display path as tooltip and the name alone as aria-label', () => {
    installApi({ name: 'dev', home: '~/.corner-office/profiles/dev' })
    render(<WindowTitleBar />)
    const badge = screen.getByLabelText('Profile dev')
    expect(badge.textContent).toBe('dev')
    expect(badge.getAttribute('title')).toBe('~/.corner-office/profiles/dev')
  })

  it('tolerates an API without a profile field', () => {
    installApi(undefined as unknown as null)
    render(<WindowTitleBar />)
    expect(screen.queryByLabelText(/^Profile /)).toBeNull()
  })
})

describe('WindowTitleBar dev build badge', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'cornerOffice')
  })

  it('shows "dev build, real data" for an unpackaged default profile', () => {
    installApi(null, true)
    render(<WindowTitleBar />)
    const badge = screen.getByLabelText('Development build, real data')
    expect(badge.textContent).toBe('dev build, real data')
  })

  it('shows no such badge when the flag is off (packaged)', () => {
    installApi(null, false)
    render(<WindowTitleBar />)
    expect(screen.queryByLabelText('Development build, real data')).toBeNull()
  })

  it('shows only the profile badge in a named profile', () => {
    installApi({ name: 'dev', home: '~/.corner-office/profiles/dev' }, true)
    render(<WindowTitleBar />)
    expect(screen.queryByLabelText('Development build, real data')).toBeNull()
    expect(screen.getByLabelText('Profile dev')).toBeTruthy()
  })
})
