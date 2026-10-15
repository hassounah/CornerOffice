import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WindowTitleBar } from '../../../renderer/components/layout/WindowTitleBar'

function installApi(profile: { name: string; home: string } | null): void {
  Object.defineProperty(window, 'cornerOffice', {
    configurable: true,
    value: {
      profile,
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

  it('renders the profile name with the home path as tooltip and aria-label', () => {
    installApi({ name: 'dev', home: '/home/u/.corner-office/profiles/dev' })
    render(<WindowTitleBar />)
    const badge = screen.getByLabelText('Profile dev, home /home/u/.corner-office/profiles/dev')
    expect(badge.textContent).toBe('dev')
    expect(badge.getAttribute('title')).toBe('/home/u/.corner-office/profiles/dev')
  })

  it('tolerates an API without a profile field', () => {
    installApi(undefined as unknown as null)
    render(<WindowTitleBar />)
    expect(screen.queryByLabelText(/^Profile /)).toBeNull()
  })
})
