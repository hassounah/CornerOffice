import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DisabledReason, type DisabledReasonProps } from '../../../renderer/components/shared/DisabledReason'

// ---------------------------------------------------------------------------
// DisabledReason — TRD §3.15.1, UX-C2
//
// Every render-prop below follows the documented usage: the caller's own
// onClick first, DisabledReason's injected `props` spread LAST, so its
// no-op `onClick` (present only when `reason` is set) takes priority.
// ---------------------------------------------------------------------------

describe('DisabledReason — reason is null', () => {
  it('renders the child with no aria-disabled attribute', () => {
    render(
      <DisabledReason reason={null} skin="office">
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).not.toHaveAttribute('disabled')
  })

  it('does not render a tooltip', () => {
    render(
      <DisabledReason reason={null} skin="office">
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('the child\'s own click handler fires normally', () => {
    const onClick = vi.fn()
    render(
      <DisabledReason reason={null} skin="office">
        {(props) => <button onClick={onClick} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe.each(['office', 'realm'] as const)('DisabledReason — reason is set (skin=%s)', (skin) => {
  it('gives the child aria-disabled="true", never the disabled attribute', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toHaveAttribute('disabled')
  })

  it('the child stays focusable', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    button.focus()
    expect(document.activeElement).toBe(button)
  })

  it('a click does not call the child\'s own handler', () => {
    const onClick = vi.fn()
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={onClick} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('the tooltip is not shown until hover or focus, and aria-describedby points to it', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Sandbox' })
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    fireEvent.mouseEnter(button)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveAttribute('id', describedBy)
    expect(tooltip).toHaveTextContent('Docker is not installed')
  })

  it('always renders the description, visually hidden, so aria-describedby never dangles', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    const description = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(description).toHaveTextContent('Docker is not installed')
    expect(description).toHaveClass('sr-only')
    expect(button).toHaveAccessibleDescription('Docker is not installed')
  })

  it('lets a long reason wrap instead of clipping', () => {
    render(
      <DisabledReason reason="A very long reason that must not be clipped inside a narrow Realm panel" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Sandbox' }))
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveClass('whitespace-normal', 'max-w-xs')
    expect(tooltip).not.toHaveClass('whitespace-nowrap')
  })

  it('a click reveals the reason without calling the child handler, and Escape hides it', () => {
    const onClick = vi.fn()
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={onClick} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Docker is not installed')
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('appears on hover and hides on mouse leave', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    fireEvent.mouseEnter(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.mouseLeave(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('appears on keyboard focus and hides on blur', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.blur(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('Escape hides a tooltip shown via hover', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    fireEvent.mouseEnter(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('Escape hides a tooltip shown via keyboard focus', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('a non-Escape key does not hide the tooltip', () => {
    render(
      <DisabledReason reason="Docker is not installed" skin={skin}>
        {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
      </DisabledReason>,
    )
    const button = screen.getByRole('button', { name: 'Sandbox' })
    fireEvent.mouseEnter(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })
})

describe('DisabledReason — reason clearing while the tooltip is shown', () => {
  it('re-rendering with reason=null hides an already-visible tooltip', () => {
    function Wrapper({ reason }: { reason: DisabledReasonProps['reason'] }) {
      return (
        <DisabledReason reason={reason} skin="office">
          {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
        </DisabledReason>
      )
    }
    const { rerender } = render(<Wrapper reason="Docker is not installed" />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Sandbox' }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    rerender(<Wrapper reason={null} />)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sandbox' })).not.toHaveAttribute('aria-disabled')
  })
})

describe('DisabledReason — focus survives the reason toggling', () => {
  function Wrapper({ reason }: { reason: DisabledReasonProps['reason'] }) {
    return (
      <DisabledReason reason={reason} skin="office">
        {(props) => <button onClick={() => {}} {...props}>Start</button>}
      </DisabledReason>
    )
  }

  it('keeps the same element and focus when the reason goes from set to null', () => {
    const { rerender } = render(<Wrapper reason="Ending" />)
    const button = screen.getByRole('button', { name: 'Start' })
    button.focus()
    rerender(<Wrapper reason={null} />)
    expect(screen.getByRole('button', { name: 'Start' })).toBe(button)
    expect(document.activeElement).toBe(button)
  })

  it('keeps the same element and focus when the reason goes from null to set', () => {
    const { rerender } = render(<Wrapper reason={null} />)
    const button = screen.getByRole('button', { name: 'Start' })
    button.focus()
    rerender(<Wrapper reason="Ending" />)
    expect(screen.getByRole('button', { name: 'Start' })).toBe(button)
    expect(document.activeElement).toBe(button)
  })
})

describe('DisabledReason — copy is identical across skins', () => {
  it('renders the same plain-text reason in both skins', () => {
    for (const skin of ['office', 'realm'] as const) {
      const { unmount } = render(
        <DisabledReason reason="Run Claude Code on this machine once first, then try again." skin={skin}>
          {(props) => <button onClick={() => {}} {...props}>Sandbox</button>}
        </DisabledReason>,
      )
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Sandbox' }))
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Run Claude Code on this machine once first, then try again.',
      )
      unmount()
    }
  })
})
