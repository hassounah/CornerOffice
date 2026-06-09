import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector: (s: { config: { appearance: { theme: string } } | null }) => unknown) =>
    selector({ config: { appearance: { theme: 'dark' } } })
  ),
}))

// ---------------------------------------------------------------------------
// Component imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { PanelError } from '../../../renderer/components/shared/PanelError'

// ---------------------------------------------------------------------------
// PanelError
// ---------------------------------------------------------------------------

describe('PanelError', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      writable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders "Something went wrong in this panel." message', () => {
    render(<PanelError />)
    expect(screen.getByText('Something went wrong in this panel.')).toBeInTheDocument()
  })

  it('shows error message when error prop provided', () => {
    const error = new Error('Boom')
    render(<PanelError error={error} />)
    expect(screen.getByText('Boom')).toBeInTheDocument()
  })

  it('does not show error message when no error', () => {
    render(<PanelError />)
    // No error message element with font-mono class (the error text container)
    expect(screen.queryByText(/Boom/)).not.toBeInTheDocument()
  })

  it('renders Retry button when onRetry provided', () => {
    render(<PanelError onRetry={vi.fn()} />)
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('does not render Retry button without onRetry', () => {
    render(<PanelError />)
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('calls onRetry when Retry clicked', () => {
    const onRetry = vi.fn()
    render(<PanelError onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('toggles stack trace details on Details click', () => {
    const error = Object.assign(new Error('Boom'), { stack: 'Error: Boom\n  at Test' })
    render(<PanelError error={error} />)

    // Details button should exist
    const detailsBtn = screen.getByRole('button', { name: /details/i })
    expect(screen.queryByText(/Error: Boom/)).not.toBeInTheDocument()

    // Click to show
    fireEvent.click(detailsBtn)
    expect(screen.getByText(/Error: Boom/)).toBeInTheDocument()

    // Click to hide
    fireEvent.click(screen.getByRole('button', { name: /hide/i }))
    expect(screen.queryByText(/Error: Boom/)).not.toBeInTheDocument()
  })

  it('copies error info to clipboard on Copy click', () => {
    const error = Object.assign(new Error('Boom'), { stack: 'Error: Boom\n  at Test' })
    const componentStack = '\n  in Foo\n  in Bar'
    render(<PanelError error={error} componentStack={componentStack} />)

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('Boom')
    )
  })
})
