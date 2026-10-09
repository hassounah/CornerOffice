import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import fs from 'fs'
import path from 'path'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolbarButton, SegmentedControl, FilterChip, Spinner } from '../../../renderer/components/code/ToolbarControls'

const CSS_PATH = path.join(__dirname, '..', '..', '..', 'renderer', 'styles', 'globals.css')
const css = fs.readFileSync(CSS_PATH, 'utf-8')

// Returns the body of the first `{ ... }` block opened at or after `from`, honouring nesting.
function blockAt(source: string, from: number): string {
  const open = source.indexOf('{', from)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
  }
  throw new Error('unbalanced braces in globals.css')
}

function mediaBlocks(query: string): string[] {
  const blocks: string[] = []
  let idx = css.indexOf(`@media (${query})`)
  while (idx !== -1) {
    blocks.push(blockAt(css, idx))
    idx = css.indexOf(`@media (${query})`, idx + 1)
  }
  return blocks
}

describe('ToolbarButton', () => {
  it('renders a type=button with skin and variant data attributes', () => {
    render(
      <ToolbarButton skin="office" variant="ghost">
        Back
      </ToolbarButton>,
    )
    const btn = screen.getByRole('button', { name: 'Back' })
    expect(btn).toHaveAttribute('type', 'button')
    expect(btn).toHaveAttribute('data-skin', 'office')
    expect(btn).toHaveAttribute('data-variant', 'ghost')
    expect(btn).toHaveClass('co-tb', 'co-tb-btn')
    expect(btn).not.toHaveAttribute('data-tone')
  })

  it('forwards ref, tabIndex, aria-pressed, aria-disabled, title and extra classes', () => {
    const ref = React.createRef<HTMLButtonElement>()
    render(
      <ToolbarButton ref={ref} skin="office" variant="segment" tabIndex={-1} aria-pressed aria-disabled title="why" className="extra">
        Seg
      </ToolbarButton>,
    )
    const btn = screen.getByRole('button', { name: 'Seg' })
    expect(ref.current).toBe(btn)
    expect(btn).toHaveAttribute('tabindex', '-1')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).toHaveAttribute('title', 'why')
    expect(btn).toHaveClass('extra')
  })

  it('busy sets aria-busy; unset leaves it absent', () => {
    const { rerender } = render(
      <ToolbarButton skin="office" variant="icon" busy>
        X
      </ToolbarButton>,
    )
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true')
    rerender(
      <ToolbarButton skin="office" variant="icon">
        X
      </ToolbarButton>,
    )
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy')
  })

  it('tone=warning sets data-tone', () => {
    render(
      <ToolbarButton skin="office" variant="pill" tone="warning">
        Retry
      </ToolbarButton>,
    )
    expect(screen.getByRole('button')).toHaveAttribute('data-tone', 'warning')
  })

  it('realm skin renders data-skin=realm', () => {
    render(
      <ToolbarButton skin="realm" variant="ghost">
        Back
      </ToolbarButton>,
    )
    expect(screen.getByRole('button')).toHaveAttribute('data-skin', 'realm')
  })

  it('swallows clicks while aria-disabled, and fires them otherwise', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <ToolbarButton skin="office" variant="pill" aria-disabled onClick={onClick}>
        Uncommitted
      </ToolbarButton>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()

    rerender(
      <ToolbarButton skin="office" variant="pill" aria-disabled={false} onClick={onClick}>
        Uncommitted
      </ToolbarButton>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('SegmentedControl', () => {
  it('is a labelled group whose segments are reachable by role and name', () => {
    render(
      <SegmentedControl skin="realm" aria-label="Tree">
        <ToolbarButton skin="realm" variant="segment" aria-pressed>
          Workspace
        </ToolbarButton>
        <ToolbarButton skin="realm" variant="segment" aria-pressed={false}>
          Sandbox
        </ToolbarButton>
      </SegmentedControl>,
    )
    const group = screen.getByRole('group', { name: 'Tree' })
    expect(group).toHaveAttribute('data-skin', 'realm')
    expect(group).toHaveClass('co-tb-seg')
    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Sandbox' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('supports aria-labelledby', () => {
    render(
      <>
        <span id="lbl">Compare:</span>
        <SegmentedControl skin="office" aria-labelledby="lbl">
          <ToolbarButton skin="office" variant="segment">
            A
          </ToolbarButton>
        </SegmentedControl>
      </>,
    )
    expect(screen.getByRole('group', { name: 'Compare:' })).toBeInTheDocument()
  })
})

describe('FilterChip', () => {
  it('pressed sets aria-pressed and renders an aria-hidden check; unpressed renders none', () => {
    const { rerender, container } = render(
      <FilterChip skin="office" pressed>
        Show ignored
      </FilterChip>,
    )
    expect(screen.getByRole('button', { name: 'Show ignored' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'pill')
    const check = container.querySelector('.co-tb-check')
    expect(check).toHaveAttribute('aria-hidden', 'true')
    expect(check).toHaveTextContent('✓')

    rerender(
      <FilterChip skin="office" pressed={false}>
        Show ignored
      </FilterChip>,
    )
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
    expect(container.querySelector('.co-tb-check')).toBeNull()
  })

  it('renders the count in .co-tb-badge and folds it into the accessible name', () => {
    const { container } = render(
      <FilterChip skin="office" pressed={false} count={3}>
        Changed files
      </FilterChip>,
    )
    expect(container.querySelector('.co-tb-badge')).toHaveTextContent('3')
    expect(screen.getByRole('button', { name: 'Changed files 3' })).toBeInTheDocument()
  })

  it('renders no badge without a count', () => {
    const { container } = render(
      <FilterChip skin="office" pressed={false}>
        Show ignored
      </FilterChip>,
    )
    expect(container.querySelector('.co-tb-badge')).toBeNull()
  })

  it('flashes the badge only when the count changes', () => {
    const { container, rerender } = render(
      <FilterChip skin="office" pressed={false} count={1}>
        Changed files
      </FilterChip>,
    )
    const first = container.querySelector('.co-tb-badge')!
    expect(first).not.toHaveClass('co-tb-flash')

    rerender(
      <FilterChip skin="office" pressed={false} count={2}>
        Changed files
      </FilterChip>,
    )
    const flashed = container.querySelector('.co-tb-badge')!
    expect(flashed).toHaveClass('co-tb-flash')
    expect(flashed).not.toBe(first) // remounted so the one-shot animation restarts

    rerender(
      <FilterChip skin="office" pressed={false} count={2}>
        Changed files
      </FilterChip>,
    )
    expect(container.querySelector('.co-tb-badge')).toBe(flashed) // same count: no remount
  })
})

describe('Spinner', () => {
  it('is aria-hidden', () => {
    const { container } = render(<Spinner />)
    expect(container.querySelector('.co-tb-spinner')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('toolbar CSS contract (globals.css)', () => {
  it('motion-only rules sit inside prefers-reduced-motion: no-preference', () => {
    const motion = mediaBlocks('prefers-reduced-motion: no-preference').join('\n')
    expect(motion).toContain('@keyframes co-tb-spin')
    expect(motion).toMatch(/\.co-tb-btn:not\(\[aria-disabled='true'\]\):active\s*\{[^}]*scale\(0\.96\)/)
  })

  it('scale(0.96) appears nowhere outside the no-preference block', () => {
    let outside = css
    for (const block of mediaBlocks('prefers-reduced-motion: no-preference')) outside = outside.replace(block, '')
    expect(outside).not.toContain('scale(0.96)')
  })

  it('reduce block disables the flash and progress animations', () => {
    const reduce = mediaBlocks('prefers-reduced-motion: reduce').join('\n')
    expect(reduce).toMatch(/\.co-tb-flash,\s*\.co-tb-progress > span\s*\{[^}]*animation:\s*none/)
  })

  it('hover and active rules exclude aria-disabled controls', () => {
    const hover = /\.co-tb-btn[^{,]*:hover\s*\{/g
    const active = /\.co-tb-btn[^{,]*:active\s*\{/g
    for (const re of [hover, active]) {
      const selectors = css.match(re) ?? []
      expect(selectors.length).toBeGreaterThan(0)
      for (const sel of selectors) expect(sel).toContain(":not([aria-disabled='true'])")
    }
  })

  it('realm skin uses theme tokens and no hard-coded hex', () => {
    const start = css.indexOf(".co-tb[data-skin='realm'] {")
    expect(start).toBeGreaterThan(-1)
    const realm = blockAt(css, start)
    expect(realm).toContain('--co-realm-keyword')
    expect(realm).toContain('--co-realm-border')
    expect(realm).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('light theme overrides the warning tone, and Retry uses it', () => {
    const light = blockAt(css, css.indexOf('.theme-light .co-tb {'))
    expect(light).toContain('--tb-warning')
    const tone = blockAt(css, css.indexOf(".co-tb-btn[data-tone='warning']"))
    expect(tone).toContain('var(--tb-warning)')
    expect(tone).not.toContain('--co-status-waiting')
  })

  it('focus ring is an offset outline, so it stays visible beside an accent fill', () => {
    const focus = blockAt(css, css.indexOf('.co-tb-btn:focus-visible {'))
    expect(focus).toContain('outline: 2px solid var(--tb-ring)')
    expect(focus).toContain('outline-offset: 2px')
  })

  it('controls never wrap their labels or shrink', () => {
    const btn = blockAt(css, css.indexOf('.co-tb-btn {'))
    expect(btn).toContain('white-space: nowrap')
    expect(btn).toContain('flex-shrink: 0')
  })
})
