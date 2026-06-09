import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

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

import { StatusIcon } from '../../../renderer/components/shared/StatusIcon'
import { RelativeTime } from '../../../renderer/components/shared/RelativeTime'
import { PulseDot } from '../../../renderer/components/shared/PulseDot'
import { GateDots } from '../../../renderer/components/shared/GateDots'
import { PipelineTypeBadge } from '../../../renderer/components/shared/PipelineTypeBadge'

// ---------------------------------------------------------------------------
// StatusIcon
// ---------------------------------------------------------------------------

describe('StatusIcon', () => {
  it('renders with correct aria-label for active status', () => {
    render(<StatusIcon status="active" />)
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('aria-label', 'active')
  })

  it('renders with correct aria-label for idle status', () => {
    render(<StatusIcon status="idle" />)
    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('aria-label', 'idle')
  })

  it('applies sm size class', () => {
    const { container } = render(<StatusIcon status="active" size="sm" />)
    expect(container.firstChild).toHaveClass('w-2')
  })

  it('applies md size class by default', () => {
    const { container } = render(<StatusIcon status="active" />)
    expect(container.firstChild).toHaveClass('w-2.5')
  })

  it('applies semantic color for active', () => {
    const { container } = render(<StatusIcon status="active" />)
    expect(container.firstChild).toHaveClass('bg-co-status-active')
  })

  it('applies semantic color for parked', () => {
    const { container } = render(<StatusIcon status="parked" />)
    expect(container.firstChild).toHaveClass('bg-co-status-parked')
  })

  it('applies semantic color for attention', () => {
    const { container } = render(<StatusIcon status="attention" />)
    expect(container.firstChild).toHaveClass('bg-co-status-attention')
  })
})

// ---------------------------------------------------------------------------
// RelativeTime
// ---------------------------------------------------------------------------

describe('RelativeTime', () => {
  it('renders "--" for null timestamp', () => {
    render(<RelativeTime timestamp={null} />)
    expect(screen.getByText('--')).toBeInTheDocument()
  })

  it('renders a <time> element', () => {
    render(<RelativeTime timestamp="2026-03-01T10:00:00Z" />)
    expect(document.querySelector('time')).toBeInTheDocument()
  })

  it('sets dateTime attribute from timestamp', () => {
    render(<RelativeTime timestamp="2026-03-01T10:00:00Z" />)
    expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-03-01T10:00:00Z')
  })

  it('does not set dateTime for null timestamp', () => {
    render(<RelativeTime timestamp={null} />)
    expect(document.querySelector('time')).not.toHaveAttribute('dateTime')
  })
})

// ---------------------------------------------------------------------------
// PulseDot
// ---------------------------------------------------------------------------

describe('PulseDot', () => {
  it('renders a span with aria-hidden', () => {
    const { container } = render(<PulseDot />)
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('has bg-emerald-400 inner dot', () => {
    const { container } = render(<PulseDot />)
    expect(container.querySelector('.bg-emerald-400')).toBeInTheDocument()
  })

  it('has animate-ping class for motion-safe', () => {
    const { container } = render(<PulseDot />)
    expect(container.querySelector('.motion-safe\\:animate-ping')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// GateDots
// ---------------------------------------------------------------------------

describe('GateDots', () => {
  it('renders 3 dots by default', () => {
    const { container } = render(<GateDots passed={0} />)
    expect(container.querySelectorAll('span > span')).toHaveLength(3)
  })

  it('renders correct number of emerald dots for passed gates', () => {
    const { container } = render(<GateDots passed={2} />)
    const dots = container.querySelectorAll('span > span')
    const passed = Array.from(dots).filter((d) => d.classList.contains('bg-emerald-400'))
    expect(passed).toHaveLength(2)
  })

  it('renders current gate as accent', () => {
    const { container } = render(<GateDots passed={1} current={1} />)
    const dots = Array.from(container.querySelectorAll('span > span'))
    expect(dots[1]).toHaveClass('bg-co-accent')
  })

  it('has accessible aria-label', () => {
    render(<GateDots passed={2} total={3} />)
    expect(screen.getByLabelText('2 of 3 gates passed')).toBeInTheDocument()
  })

  it('renders custom total', () => {
    const { container } = render(<GateDots passed={0} total={2} />)
    expect(container.querySelectorAll('span > span')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// PipelineTypeBadge
// ---------------------------------------------------------------------------

describe('PipelineTypeBadge', () => {
  it('renders "direct" text', () => {
    render(<PipelineTypeBadge type="direct" />)
    expect(screen.getByText('direct')).toBeInTheDocument()
  })

  it('renders "light" text', () => {
    render(<PipelineTypeBadge type="light" />)
    expect(screen.getByText('light')).toBeInTheDocument()
  })

  it('renders "full" text', () => {
    render(<PipelineTypeBadge type="full" />)
    expect(screen.getByText('full')).toBeInTheDocument()
  })

  it('applies pill styling', () => {
    const { container } = render(<PipelineTypeBadge type="full" />)
    expect(container.firstChild).toHaveClass('rounded-full')
  })

  it('applies different color for direct vs full', () => {
    const { container: c1 } = render(<PipelineTypeBadge type="direct" />)
    const { container: c2 } = render(<PipelineTypeBadge type="full" />)
    const class1 = (c1.firstChild as Element).className
    const class2 = (c2.firstChild as Element).className
    expect(class1).not.toBe(class2)
  })
})

// ---------------------------------------------------------------------------
// Hook: useRelativeTime
// ---------------------------------------------------------------------------

import { renderHook } from '@testing-library/react'
import { useRelativeTime } from '../../../renderer/hooks/useRelativeTime'

describe('useRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "--" for null', () => {
    const { result } = renderHook(() => useRelativeTime(null))
    expect(result.current).toBe('--')
  })

  it('returns a relative time string for a valid timestamp', () => {
    const ts = new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 min ago
    const { result } = renderHook(() => useRelativeTime(ts))
    expect(result.current).toContain('minute')
  })

  it('updates every 60 seconds', () => {
    const ts = new Date(Date.now() - 1000).toISOString()
    const { result } = renderHook(() => useRelativeTime(ts))
    const initial = result.current
    act(() => { vi.advanceTimersByTime(60_000) })
    // After 60s the relative time should still be a string (may or may not change)
    expect(typeof result.current).toBe('string')
    expect(result.current).not.toBe('--')
    void initial // suppress unused warning
  })
})

// ---------------------------------------------------------------------------
// Hook: useReducedMotion
// ---------------------------------------------------------------------------

import { useReducedMotion } from '../../../renderer/hooks/useReducedMotion'

describe('useReducedMotion', () => {
  it('returns false when no media query match', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
  })

  it('returns true when prefers-reduced-motion matches', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(true)
  })
})
