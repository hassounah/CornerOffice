import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RealmTooltip } from '../../../renderer/components/realm/shared/RealmTooltip'

describe('RealmTooltip', () => {
  it('renders children', () => {
    render(
      <RealmTooltip label="Test tooltip">
        <button>Hover me</button>
      </RealmTooltip>,
    )
    expect(screen.getByText('Hover me')).toBeInTheDocument()
  })

  it('renders tooltip label text', () => {
    render(
      <RealmTooltip label="Info text">
        <span>Target</span>
      </RealmTooltip>,
    )
    expect(screen.getByText('Info text')).toBeInTheDocument()
  })

  it('sets role="tooltip" on the tooltip element', () => {
    render(
      <RealmTooltip label="Tooltip content">
        <span>Target</span>
      </RealmTooltip>,
    )
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tooltip content')
  })

  it('links aria-describedby to the tooltip id', () => {
    const { container } = render(
      <RealmTooltip label="Linked tooltip">
        <span>Target</span>
      </RealmTooltip>,
    )
    const wrapper = container.firstChild as HTMLElement
    const tooltipId = wrapper.getAttribute('aria-describedby')
    expect(tooltipId).toBeTruthy()
    expect(screen.getByRole('tooltip').id).toBe(tooltipId)
  })

  it('applies custom className', () => {
    const { container } = render(
      <RealmTooltip label="Tip" className="custom-class">
        <span>Target</span>
      </RealmTooltip>,
    )
    expect(container.firstChild).toHaveClass('custom-class')
  })

  it('applies default group class without custom className', () => {
    const { container } = render(
      <RealmTooltip label="Tip">
        <span>Target</span>
      </RealmTooltip>,
    )
    expect(container.firstChild).toHaveClass('relative', 'group')
  })
})
