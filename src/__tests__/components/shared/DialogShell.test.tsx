import React, { useRef, useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'
import { DialogShell } from '../../../renderer/components/shared/DialogShell'

interface HarnessProps {
  onCancel?: () => void
  withFallback?: boolean
  initiallyOpen?: boolean
}

/** An opener button plus a dialog with three focusables; the first is the initial focus. */
function Harness({ onCancel = vi.fn(), withFallback = false, initiallyOpen = false }: HarnessProps): React.ReactElement {
  const [open, setOpen] = useState(initiallyOpen)
  const [showOpener, setShowOpener] = useState(true)
  const firstRef = useRef<HTMLButtonElement>(null)
  const fallbackRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      {withFallback && <button ref={fallbackRef}>fallback</button>}
      {showOpener && <button onClick={() => setOpen(true)}>opener</button>}
      <button onClick={() => setShowOpener(false)}>remove opener</button>
      <DialogShell
        open={open}
        onCancel={() => {
          onCancel()
          setOpen(false)
        }}
        labelledBy="t"
        describedBy="d"
        initialFocusRef={firstRef}
        fallbackFocus={withFallback ? fallbackRef : undefined}
      >
        <h2 id="t">Title</h2>
        <p id="d">Description</p>
        <button ref={firstRef}>one</button>
        <input aria-label="two" />
        <button>three</button>
      </DialogShell>
    </div>
  )
}

function tab(shift = false): void {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DialogShell', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <DialogShell open={false} onCancel={vi.fn()} labelledBy="t" initialFocusRef={{ current: null }}>
        <h2 id="t">x</h2>
      </DialogShell>,
    )
    expect(container.firstChild).toBeNull()
  })

  it('opens as a native modal dialog with labelledby / describedby', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(<Harness initiallyOpen />)
    const dialog = screen.getByRole('dialog', { name: 'Title' })
    expect(dialog.tagName).toBe('DIALOG')
    expect(dialog).toHaveAttribute('aria-describedby', 'd')
    expect(showModal).toHaveBeenCalledTimes(1)
    showModal.mockRestore()
  })

  it('supports role="alertdialog"', () => {
    render(
      <DialogShell open onCancel={vi.fn()} labelledBy="t" initialFocusRef={{ current: null }} role="alertdialog">
        <h2 id="t">x</h2>
      </DialogShell>,
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('focuses initialFocusRef on open', () => {
    render(<Harness initiallyOpen />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'one' }))
  })

  it('Tab and Shift+Tab cycle across three focusables', () => {
    render(<Harness initiallyOpen />)
    const one = screen.getByRole('button', { name: 'one' })
    const two = screen.getByLabelText('two')
    const three = screen.getByRole('button', { name: 'three' })

    // Forward: from the last element wraps to the first.
    three.focus()
    tab()
    expect(document.activeElement).toBe(one)

    // Backward: from the first element wraps to the last.
    tab(true)
    expect(document.activeElement).toBe(three)

    // Middle elements are left to the browser (no interception).
    two.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => {
      document.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(false)
  })

  it('pulls focus back into the dialog when it has escaped', () => {
    render(<Harness initiallyOpen />)
    const outside = screen.getByRole('button', { name: 'remove opener' })
    outside.focus()
    tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'one' }))
  })

  it('swallows Tab when nothing inside is focusable', () => {
    const ref = { current: null }
    render(
      <DialogShell open onCancel={vi.fn()} labelledBy="t" initialFocusRef={ref}>
        <h2 id="t">x</h2>
      </DialogShell>,
    )
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => {
      document.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
  })

  it('traps Tab across summary, contenteditable, media controls and tabindex=0, skipping disabled and negative tabindex', () => {
    const first = React.createRef<HTMLElement>()
    render(
      <DialogShell open onCancel={vi.fn()} labelledBy="t" initialFocusRef={first}>
        <h2 id="t">x</h2>
        <details>
          <summary ref={first}>sum</summary>
        </details>
        <div contentEditable suppressContentEditableWarning data-testid="ce" />
        <div contentEditable={false} tabIndex={-1} />
        <video controls data-testid="vid" />
        <div tabIndex={-2} />
        <div tabIndex={0} data-testid="ti" />
        <fieldset disabled>
          <div tabIndex={0} {...{ disabled: true }} />
        </fieldset>
      </DialogShell>,
    )
    // The last tabbable is the tabindex=0 div; the first is the summary. Anything else
    // (disabled, negative tabindex) would change where Tab wraps to.
    screen.getByTestId('ti').focus()
    tab()
    expect(document.activeElement).toBe(first.current)
    tab(true)
    expect(document.activeElement).toBe(screen.getByTestId('ti'))
  })

  it('ignores hidden and aria-hidden elements in the trap', () => {
    const ref = React.createRef<HTMLButtonElement>()
    render(
      <DialogShell open onCancel={vi.fn()} labelledBy="t" initialFocusRef={ref}>
        <h2 id="t">x</h2>
        <button ref={ref}>only</button>
        <button hidden>gone</button>
        <button aria-hidden="true">masked</button>
      </DialogShell>,
    )
    tab()
    expect(document.activeElement).toBe(ref.current)
  })

  it('Escape calls onCancel', () => {
    const onCancel = vi.fn()
    render(<Harness onCancel={onCancel} initiallyOpen />)
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('blocks the native cancel event so React state stays authoritative', () => {
    render(<Harness initiallyOpen />)
    const ev = new Event('cancel', { cancelable: true })
    screen.getByRole('dialog').dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('returns focus to the opener when closed', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'one' }))

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('closes the modal dialog BEFORE restoring focus (a modal makes the page inert)', () => {
    const order: string[] = []
    const closeSpy = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(() => {
      order.push('close')
    })
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {
      order.push('focus')
    })
    try {
      render(<Harness />)
      const opener = screen.getByRole('button', { name: 'opener' })
      fireEvent.click(opener)
      order.length = 0

      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' })
      })
      expect(order).toEqual(['close', 'focus'])
    } finally {
      closeSpy.mockRestore()
      focusSpy.mockRestore()
    }
  })

  it('moves focus to the fallback when the opener has unmounted', () => {
    render(<Harness withFallback />)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'remove opener' }))
    expect(screen.queryByRole('button', { name: 'opener' })).toBeNull()

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'fallback' }))
  })

  it('leaves focus alone when the opener is gone and there is no fallback', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'remove opener' }))
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('routes Escape only to the topmost of two open shells', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    const outerRef = React.createRef<HTMLButtonElement>()
    const innerRef = React.createRef<HTMLButtonElement>()
    function Stack(): React.ReactElement {
      const [showInner, setShowInner] = useState(false)
      return (
        <DialogShell open onCancel={outer} labelledBy="o" initialFocusRef={outerRef}>
          <h2 id="o">outer</h2>
          <button ref={outerRef} onClick={() => setShowInner(true)}>
            open inner
          </button>
          <DialogShell
            open={showInner}
            onCancel={() => {
              inner()
              setShowInner(false)
            }}
            labelledBy="i"
            initialFocusRef={innerRef}
          >
            <h2 id="i">inner</h2>
            <button ref={innerRef}>inner ok</button>
          </DialogShell>
        </DialogShell>
      )
    }
    render(<Stack />)
    fireEvent.click(screen.getByRole('button', { name: 'open inner' }))

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('two shells mounting in one commit keep separate ids: only the topmost handles Escape', () => {
    const a = vi.fn()
    const b = vi.fn()
    const ra = React.createRef<HTMLButtonElement>()
    const rb = React.createRef<HTMLButtonElement>()
    render(
      <>
        <DialogShell open onCancel={a} labelledBy="a" initialFocusRef={ra}>
          <h2 id="a">a</h2>
          <button ref={ra}>a</button>
        </DialogShell>
        <DialogShell open onCancel={b} labelledBy="b" initialFocusRef={rb}>
          <h2 id="b">b</h2>
          <button ref={rb}>b</button>
        </DialogShell>
      </>,
    )
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })

  it('passes an axe check', async () => {
    const { container } = render(<Harness initiallyOpen />)
    // jsdom has no layout engine, so colour contrast cannot be computed.
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations).toEqual([])
  })
})
