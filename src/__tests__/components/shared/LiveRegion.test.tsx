import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import axe from 'axe-core'
import { LiveRegion, WorkspaceLiveRegion } from '../../../renderer/components/shared/LiveRegion'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'

// ---------------------------------------------------------------------------
// LiveRegion (#0039 UX H-2): a visually hidden polite role="status" region, fed by the workspace store's `announce`.
// ---------------------------------------------------------------------------

describe('LiveRegion', () => {
  it('is a polite, atomic status region', () => {
    render(<LiveRegion message="api added" />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
    expect(region).toHaveTextContent('api added')
    expect(region).toHaveClass('sr-only')
  })

  it('renders an empty region when there is nothing to say', () => {
    render(<LiveRegion message="" />)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('replaces the text node when the sequence changes, so a repeat is announced again', () => {
    const { rerender } = render(<LiveRegion message="api added" seq={1} />)
    const first = screen.getByText('api added')
    rerender(<LiveRegion message="api added" seq={2} />)
    expect(screen.getByText('api added')).not.toBe(first)
  })

  it('keeps the same node when nothing changed', () => {
    const { rerender } = render(<LiveRegion message="api added" seq={1} />)
    const first = screen.getByText('api added')
    rerender(<LiveRegion message="api added" seq={1} />)
    expect(screen.getByText('api added')).toBe(first)
  })

  it('passes an axe check', async () => {
    const { container } = render(<LiveRegion message="api hidden. Show it from Hidden (1)" />)
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations).toEqual([])
  })
})

describe('WorkspaceLiveRegion', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ announce: '', announceSeq: 0 })
  })

  it('shows the store\'s announcement and updates when it changes', () => {
    render(<WorkspaceLiveRegion />)
    expect(screen.getByRole('status').textContent).toBe('')
    act(() => useWorkspaceStore.setState({ announce: 'api added', announceSeq: 1 }))
    expect(screen.getByRole('status')).toHaveTextContent('api added')
    act(() => useWorkspaceStore.setState({ announce: 'api removed', announceSeq: 2 }))
    expect(screen.getByRole('status')).toHaveTextContent('api removed')
  })
})
