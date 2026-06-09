import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  IconActive,
  IconWaiting,
  IconParked,
  IconIdle,
  IconAttention,
  IconGateDesign,
  IconGatePlan,
  IconGateImplement,
  IconGateReview,
  IconGatePassed,
  IconDashboard,
  IconActivity,
  IconInstincts,
  IconSettings,
  IconShip,
  IconSeance,
  IconParkedPipeline,
  IconInbox,
} from '../../../renderer/components/icons'

// Each icon is a pure SVG component — just verify it renders without throwing.

describe('Icons', () => {
  it('renders IconActive', () => {
    const { container } = render(<IconActive />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconWaiting', () => {
    const { container } = render(<IconWaiting />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconParked', () => {
    const { container } = render(<IconParked />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconIdle', () => {
    const { container } = render(<IconIdle />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconAttention', () => {
    const { container } = render(<IconAttention />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconGateDesign', () => {
    const { container } = render(<IconGateDesign />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconGatePlan', () => {
    const { container } = render(<IconGatePlan />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconGateImplement', () => {
    const { container } = render(<IconGateImplement />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconGateReview', () => {
    const { container } = render(<IconGateReview />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconGatePassed', () => {
    const { container } = render(<IconGatePassed />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconDashboard', () => {
    const { container } = render(<IconDashboard />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconActivity', () => {
    const { container } = render(<IconActivity />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconInstincts', () => {
    const { container } = render(<IconInstincts />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconSettings', () => {
    const { container } = render(<IconSettings />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconShip', () => {
    const { container } = render(<IconShip />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconSeance', () => {
    const { container } = render(<IconSeance />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconParkedPipeline', () => {
    const { container } = render(<IconParkedPipeline />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders IconInbox', () => {
    const { container } = render(<IconInbox />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('passes custom size prop', () => {
    const { container } = render(<IconActive size={32} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '32')
    expect(svg).toHaveAttribute('height', '32')
  })

  it('passes custom className prop', () => {
    const { container } = render(<IconActive className="custom-class" />)
    expect(container.querySelector('svg')).toHaveClass('custom-class')
  })
})
