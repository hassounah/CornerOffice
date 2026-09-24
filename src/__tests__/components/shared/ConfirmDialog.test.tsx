import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ConfirmDialog, type ConfirmDialogProps } from '../../../renderer/components/shared/ConfirmDialog'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultProps: ConfirmDialogProps = {
  open: true,
  title: 'Unsaved changes',
  message: 'You have unsaved changes — discard them?',
  confirmLabel: 'Discard',
  cancelLabel: 'Keep editing',
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

function renderDialog(overrides: Partial<ConfirmDialogProps> = {}) {
  return render(<ConfirmDialog {...defaultProps} {...overrides} />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('ConfirmDialog — office skin (default)', () => {
  it('renders title and message', () => {
    renderDialog()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getByText('You have unsaved changes — discard them?')).toBeInTheDocument()
  })

  it('renders confirm and cancel button labels', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeInTheDocument()
  })

  it('has role="alertdialog" (§17 R17)', () => {
    renderDialog()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('returns null when open=false', () => {
    const { container } = renderDialog({ open: false })
    expect(container.firstChild).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Accessibility — initial focus (§17 R17: initial focus on cancel/Keep editing)
// ---------------------------------------------------------------------------

describe('ConfirmDialog — initial focus', () => {
  it('focuses the cancel button on open (§17 R17)', () => {
    renderDialog()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }))
  })

  it('does NOT focus the confirm button by default', () => {
    renderDialog()
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Discard' }))
  })
})

// ---------------------------------------------------------------------------
// Interactions — onConfirm / onCancel
// ---------------------------------------------------------------------------

describe('ConfirmDialog — button clicks', () => {
  it('calls onConfirm when confirm button clicked', () => {
    const onConfirm = vi.fn()
    renderDialog({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn()
    renderDialog({ onCancel })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when backdrop clicked', () => {
    const onCancel = vi.fn()
    const { container } = renderDialog({ onCancel })
    // The backdrop is the first child inside the alertdialog
    const backdrop = container.querySelector('[style*="absolute"]') ?? container.querySelector('.absolute.inset-0')
    if (backdrop) fireEvent.click(backdrop)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Keyboard — Escape fires onCancel, NOT onConfirm (§17 R17)
// ---------------------------------------------------------------------------

describe('ConfirmDialog — Escape key (§17 R17)', () => {
  it('fires onCancel on Escape, not onConfirm', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', bubbles: true })
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does NOT fire Escape when closed', () => {
    const onCancel = vi.fn()
    renderDialog({ open: false, onCancel })

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', bubbles: true })
    })

    expect(onCancel).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Realm skin (§17 R18)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Top layer — regression: the confirm used to be a `fixed z-[9999]` div, which
// painted BENEATH the Office doc viewer's modal <dialog> (top layer beats any
// z-index) and was inert while the viewer was open.
// ---------------------------------------------------------------------------

describe('ConfirmDialog — top layer', () => {
  it.each(['office', 'realm'] as const)('%s skin opens as a native modal <dialog>', (skin) => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    renderDialog({ skin })

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.tagName).toBe('DIALOG')
    expect(showModal).toHaveBeenCalledTimes(1)
    expect((dialog as HTMLDialogElement).open).toBe(true)
    showModal.mockRestore()
  })

  it('blocks the native Escape close so React state stays authoritative', () => {
    renderDialog()
    const dialog = screen.getByRole('alertdialog')
    const cancelEvent = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancelEvent)
    expect(cancelEvent.defaultPrevented).toBe(true)
    expect(defaultProps.onConfirm).not.toHaveBeenCalled()
  })
})

describe('ConfirmDialog — realm skin (§17 R18)', () => {
  it('renders title and message in realm skin', () => {
    renderDialog({ skin: 'realm' })
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getByText('You have unsaved changes — discard them?')).toBeInTheDocument()
  })

  it('has role="alertdialog" in realm skin', () => {
    renderDialog({ skin: 'realm' })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('focuses cancel button on open in realm skin (§17 R17)', () => {
    renderDialog({ skin: 'realm' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }))
  })

  it('fires onConfirm on confirm button click in realm skin', () => {
    const onConfirm = vi.fn()
    renderDialog({ skin: 'realm', onConfirm })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel on cancel button click in realm skin', () => {
    const onCancel = vi.fn()
    renderDialog({ skin: 'realm', onCancel })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape fires onCancel in realm skin', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ skin: 'realm', onConfirm, onCancel })

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', bubbles: true })
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('realm panel is positioned above the backdrop so it stays clickable', () => {
    // Live-verify regression: the realm panel previously had no `position`, so the
    // absolutely-positioned backdrop painted over it — dimming the panel and
    // swallowing all clicks into onCancel. The panel must be positioned (relative)
    // with a stacking index so it sits above the backdrop. (jsdom can't test paint
    // order, so we assert the structural fix.)
    renderDialog({ skin: 'realm' })
    const panel = screen.getByRole('button', { name: 'Discard' }).parentElement?.parentElement
    expect(panel).toBeTruthy()
    expect(panel!.style.position).toBe('relative')
    expect(Number(panel!.style.zIndex)).toBeGreaterThan(0)
  })
})
