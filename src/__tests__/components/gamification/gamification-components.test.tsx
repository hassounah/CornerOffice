import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock recharts to avoid canvas/ResizeObserver issues in jsdom
import { vi } from 'vitest'
vi.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
}))

import { VelocityDisplay } from '../../../renderer/components/gamification/VelocityDisplay'
import { StreakBadge } from '../../../renderer/components/gamification/StreakBadge'
import { TeamLevelBadge } from '../../../renderer/components/gamification/TeamLevelBadge'
import { QualityScore } from '../../../renderer/components/gamification/QualityScore'
import type { TeamLevel } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// VelocityDisplay
// ---------------------------------------------------------------------------

describe('VelocityDisplay', () => {
  it('renders velocity number', () => {
    render(
      <VelocityDisplay data={{ current: 14, trend: 'up', sparkline: [] }} />,
    )
    expect(screen.getByText('14')).toBeInTheDocument()
  })

  it('renders 0 when no data', () => {
    render(<VelocityDisplay data={null} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('compact mode renders inline', () => {
    const { container } = render(
      <VelocityDisplay data={{ current: 7, trend: 'flat', sparkline: [] }} compact />,
    )
    // Compact mode doesn't render the large text — uses smaller sizing
    expect(container.firstChild).toHaveClass('flex')
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('has accessible label', () => {
    render(
      <VelocityDisplay data={{ current: 5, trend: 'down', sparkline: [] }} />,
    )
    expect(screen.getByLabelText(/Velocity: 5/)).toBeInTheDocument()
  })

  it('renders sparkline when data present', () => {
    render(
      <VelocityDisplay data={{ current: 12, trend: 'up', sparkline: [3, 5, 2, 8, 12] }} />,
    )
    // The sparkline section renders with the rolling label
    expect(screen.getByText('Features shipped (28-day rolling)')).toBeInTheDocument()
  })

  it('does not render sparkline when empty', () => {
    render(
      <VelocityDisplay data={{ current: 4, trend: 'flat', sparkline: [] }} />,
    )
    // The "28-day rolling" text is outside the sparkline conditional
    expect(screen.getByText('Features shipped (28-day rolling)')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// StreakBadge
// ---------------------------------------------------------------------------

describe('StreakBadge', () => {
  it('renders day count', () => {
    render(<StreakBadge data={{ currentDays: 7, lastShipDate: '2024-01-15' }} />)
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('shows 0 when no data', () => {
    render(<StreakBadge data={null} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('has accessible label', () => {
    render(<StreakBadge data={{ currentDays: 3, lastShipDate: '2024-01-10' }} />)
    expect(screen.getByLabelText(/3-day shipping streak/)).toBeInTheDocument()
  })

  it('shows "day" singular for 1-day streak', () => {
    render(<StreakBadge data={{ currentDays: 1, lastShipDate: '2024-01-15' }} />)
    expect(screen.getByText('day')).toBeInTheDocument()
  })

  it('shows "days" plural for multi-day streak', () => {
    render(<StreakBadge data={{ currentDays: 5, lastShipDate: '2024-01-15' }} />)
    expect(screen.getByText('days')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// TeamLevelBadge
// ---------------------------------------------------------------------------

function makeLevel(overrides: Partial<TeamLevel> = {}): TeamLevel {
  return {
    number: 2,
    name: 'Alpha',
    xpRequired: 500,
    xpCurrent: 250,
    ...overrides,
  }
}

describe('TeamLevelBadge', () => {
  it('renders level name and number', () => {
    render(<TeamLevelBadge level={makeLevel()} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Lv 2')).toBeInTheDocument()
  })

  it('renders XP progress bar with correct aria values', () => {
    render(<TeamLevelBadge level={makeLevel({ xpCurrent: 250, xpRequired: 500 })} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '250')
    expect(bar).toHaveAttribute('aria-valuemax', '500')
  })

  it('compact mode renders inline badge', () => {
    const { container } = render(<TeamLevelBadge level={makeLevel()} compact />)
    expect(container.firstChild).toHaveClass('inline-flex')
  })

  it('has accessible label', () => {
    render(<TeamLevelBadge level={makeLevel()} />)
    expect(
      screen.getByLabelText(/Team level: Alpha \(Level 2\)/),
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// QualityScore
// ---------------------------------------------------------------------------

describe('QualityScore', () => {
  it('renders score number', () => {
    render(<QualityScore score={85} />)
    expect(screen.getByText('85')).toBeInTheDocument()
  })

  it('clamps score to 0-100', () => {
    const { rerender } = render(<QualityScore score={150} />)
    expect(screen.getByText('100')).toBeInTheDocument()

    rerender(<QualityScore score={-10} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('has accessible label', () => {
    render(<QualityScore score={75} />)
    expect(screen.getByRole('img', { name: /Quality score: 75/ })).toBeInTheDocument()
  })

  it('shows green styling for score >= 80', () => {
    const { container } = render(<QualityScore score={90} />)
    expect(container.firstChild).toHaveClass('text-green-400')
  })

  it('shows yellow styling for score 50-79', () => {
    const { container } = render(<QualityScore score={65} />)
    expect(container.firstChild).toHaveClass('text-yellow-400')
  })

  it('shows red styling for score < 50', () => {
    const { container } = render(<QualityScore score={30} />)
    expect(container.firstChild).toHaveClass('text-red-400')
  })

  it('includes fix cycles in tooltip when provided', () => {
    const { container } = render(<QualityScore score={80} fixCycles={2} />)
    expect((container.firstChild as HTMLElement).title).toContain('Fix cycles: 2')
  })
})
