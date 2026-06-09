import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PermissionRequestItem } from '../../../renderer/components/channels/PermissionRequestItem'
import type { PermissionRequest } from '../../../renderer/stores/permission-store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    shortId: 'sess-1',
    requestId: 'abcde',
    toolName: 'Bash',
    description: 'Run a command',
    inputPreview: 'ls -la',
    receivedAt: Date.now(),
    sendError: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionRequestItem', () => {
  it('renders tool name', () => {
    render(<PermissionRequestItem request={makeRequest()} isActive={true} onVerdict={vi.fn()} />)
    expect(screen.getByText('Bash')).toBeTruthy()
  })

  it('renders description', () => {
    render(<PermissionRequestItem request={makeRequest()} isActive={true} onVerdict={vi.fn()} />)
    expect(screen.getByText('Run a command')).toBeTruthy()
  })

  it('renders inputPreview as plain text — XSS: <script> renders literally, not as DOM element', () => {
    const xssPayload = '<script>alert(1)</script>'
    render(
      <PermissionRequestItem
        request={makeRequest({ inputPreview: xssPayload })}
        isActive={true}
        onVerdict={vi.fn()}
      />
    )
    // The text must appear as a literal string in the DOM
    expect(screen.getByText(xssPayload)).toBeTruthy()
    // No actual <script> element must be created
    expect(document.querySelector('script[data-testid]')).toBeNull()
    // The pre element contains the literal text, not injected HTML
    const pre = document.querySelector('pre')
    expect(pre?.textContent).toBe(xssPayload)
  })

  it('truncates inputPreview at 200 chars', () => {
    const long = 'a'.repeat(250)
    render(<PermissionRequestItem request={makeRequest({ inputPreview: long })} isActive={true} onVerdict={vi.fn()} />)
    const pre = document.querySelector('pre')
    expect(pre?.textContent?.length).toBeLessThan(250)
    expect(pre?.textContent).toContain('a'.repeat(200))
  })

  it('shows Allow and Deny buttons when isActive=true and no sendError', () => {
    render(<PermissionRequestItem request={makeRequest()} isActive={true} onVerdict={vi.fn()} />)
    expect(screen.getByRole('button', { name: /approve bash/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /deny bash/i })).toBeTruthy()
  })

  it('hides buttons when isActive=false', () => {
    render(<PermissionRequestItem request={makeRequest()} isActive={false} onVerdict={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('calls onVerdict with allow when Allow is clicked', () => {
    const onVerdict = vi.fn()
    render(<PermissionRequestItem request={makeRequest()} isActive={true} onVerdict={onVerdict} />)
    fireEvent.click(screen.getByRole('button', { name: /approve bash/i }))
    expect(onVerdict).toHaveBeenCalledWith('allow')
  })

  it('calls onVerdict with deny when Deny is clicked', () => {
    const onVerdict = vi.fn()
    render(<PermissionRequestItem request={makeRequest()} isActive={true} onVerdict={onVerdict} />)
    fireEvent.click(screen.getByRole('button', { name: /deny bash/i }))
    expect(onVerdict).toHaveBeenCalledWith('deny')
  })

  it('shows Retry button with correct label when sendError=true and failedBehavior=deny', () => {
    render(
      <PermissionRequestItem
        request={makeRequest({ sendError: true, failedBehavior: 'deny' })}
        isActive={true}
        onVerdict={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /retry deny/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
  })

  it('shows Retry Allow button when sendError=true and failedBehavior=allow', () => {
    render(
      <PermissionRequestItem
        request={makeRequest({ sendError: true, failedBehavior: 'allow' })}
        isActive={true}
        onVerdict={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /retry allow/i })).toBeTruthy()
  })

  it('calls onVerdict with failedBehavior when Retry is clicked', () => {
    const onVerdict = vi.fn()
    render(
      <PermissionRequestItem
        request={makeRequest({ sendError: true, failedBehavior: 'deny' })}
        isActive={true}
        onVerdict={onVerdict}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /retry deny/i }))
    expect(onVerdict).toHaveBeenCalledWith('deny')
  })
})
