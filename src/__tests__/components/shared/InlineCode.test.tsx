import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InlineCode } from '../../../renderer/components/shared/InlineCode'
import { isFoundOnHost, writableRootPath } from '../../../renderer/utils/host-availability'

describe('InlineCode', () => {
  it('renders backtick spans as <code> with no raw backticks', () => {
    const { container } = render(<p><InlineCode text="`codex` may not be installed: run `codex login` first." /></p>)
    expect(container.textContent).toBe('codex may not be installed: run codex login first.')
    expect([...container.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['codex', 'codex login'])
  })

  it('turns a code span with a space into a copy button only when copy buttons are asked for', () => {
    const { container, unmount } = render(<p><InlineCode text="Install with `pnpm add -g x`." /></p>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('code')).toHaveTextContent('pnpm add -g x')
    unmount()

    render(<p><InlineCode text="`codex` is missing. Install with `pnpm add -g x`." copyCommands={{ buttonClass: 'b' }} /></p>)
    expect(screen.getByRole('button', { name: 'Copy command pnpm add -g x' })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1) // the one-word `codex` stays plain
  })

  it('shows an unmatched trailing backtick as text, and is safe with markup in the copy', () => {
    const { container } = render(<p><InlineCode text="a `b` c `d" /></p>)
    expect(container.textContent).toBe('a b c `d')
    const hostile = render(<p><InlineCode text="`<img src=x onerror=alert(1)>`" /></p>)
    expect(hostile.container.querySelector('img')).toBeNull()
  })
})

describe('host-availability helpers', () => {
  it('reads found, not-found, a writable-root path, and a missing entry', () => {
    expect(isFoundOnHost('found')).toBe(true)
    expect(isFoundOnHost('found-in-writable-root:/x/codex')).toBe(true)
    expect(isFoundOnHost('not-found')).toBe(false)
    expect(isFoundOnHost(undefined)).toBe(false)
    expect(writableRootPath('found-in-writable-root:/x/codex')).toBe('/x/codex')
    expect(writableRootPath('found')).toBeNull()
    expect(writableRootPath(undefined)).toBeNull()
  })
})
