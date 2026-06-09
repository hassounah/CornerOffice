import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

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

import { ErrorBoundary } from '../../../renderer/components/shared/ErrorBoundary'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) {
    throw new Error('Test render error')
  }
  return <div>Child content</div>
}

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  let consoleErrorSpy: { mockRestore: () => void }

  beforeEach(() => {
    // Suppress React's error boundary console output in tests
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Child content</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('shows PanelError when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Something went wrong in this panel.')).toBeInTheDocument()
  })

  it('shows custom fallback when provided via fallback prop', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Custom fallback')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong in this panel.')).not.toBeInTheDocument()
  })

  it('calls componentDidCatch and logs to console.error', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ErrorBoundary] Caught render error:\n',
      'Error:', 'Test render error', '\n',
      'Stack:', expect.any(String), '\n',
      'Component stack:', expect.any(String),
    )
  })

  it('retry resets error state and re-renders children', () => {
    // Use a mutable flag so child stops throwing after Retry
    let shouldThrow = true

    function ControllableChild(): React.ReactElement {
      if (shouldThrow) throw new Error('Test render error')
      return <div>Child content</div>
    }

    render(
      <ErrorBoundary>
        <ControllableChild />
      </ErrorBoundary>
    )
    expect(screen.getByText('Something went wrong in this panel.')).toBeInTheDocument()

    // Stop throwing before clicking Retry so the re-render succeeds
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('passes error and componentStack to PanelError', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    )
    // The error message should be visible
    expect(screen.getByText('Test render error')).toBeInTheDocument()
    // Details button is present (indicates componentStack was passed)
    expect(screen.getByRole('button', { name: /details/i })).toBeInTheDocument()
  })
})
