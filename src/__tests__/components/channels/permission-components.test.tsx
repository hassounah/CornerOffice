import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { PermissionRequest } from '../../../renderer/stores/permission-store'
import type { ChannelSession } from '@main/types/channels'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock PermissionRequestItem — dev-2 implements Step 10
vi.mock('../../../renderer/components/channels/PermissionRequestItem', () => ({
  PermissionRequestItem: ({ request, isActive, onVerdict }: {
    request: PermissionRequest
    isActive: boolean
    onVerdict: (behavior: 'allow' | 'deny') => void
  }) => (
    <div data-testid="permission-item" data-request-id={request.requestId} data-active={String(isActive)}>
      <span>{request.toolName}</span>
      <button onClick={() => onVerdict('allow')}>Allow</button>
      <button onClick={() => onVerdict('deny')}>Deny</button>
    </div>
  ),
}))

const mockSendVerdict = vi.fn()
const mockQueues: Record<string, PermissionRequest[]> = {}

vi.mock('../../../renderer/stores/permission-store', () => ({
  usePermissionStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ queues: mockQueues, sendVerdict: mockSendVerdict })
  ),
}))

const mockSessions: ChannelSession[] = []

vi.mock('../../../renderer/stores/channels-store', () => ({
  useChannelsStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ sessions: mockSessions })
  ),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspaces: [{ slug: 'my-ws', path: '/home/user/my-ws' }] })
  ),
}))

import { PermissionScroll } from '../../../renderer/components/channels/PermissionScroll'
import { PermissionButton } from '../../../renderer/components/channels/PermissionButton'

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

function makeSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    shortId: 'sess-1',
    pid: 1234,
    workspaceDir: '/home/user/my-ws',
    workspaceName: 'my-ws',
    channelPort: 8080,
    channelToken: 'tok',
    connectionState: 'connected',
    ...overrides,
  }
}

function resetMocks() {
  Object.keys(mockQueues).forEach((k) => delete mockQueues[k])
  mockSessions.length = 0
  mockSendVerdict.mockClear()
}

// ---------------------------------------------------------------------------
// PermissionScroll tests
// ---------------------------------------------------------------------------

describe('PermissionScroll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMocks()
  })

  it('renders invisible spacer (h-0) when no requests pending', () => {
    const { container } = render(<PermissionScroll workspaceSlug="my-ws" />)
    const spacer = container.querySelector('[aria-hidden="true"]')
    expect(spacer).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="permission-item"]')).toHaveLength(0)
  })

  it('renders permission items when requests are pending', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    render(<PermissionScroll workspaceSlug="my-ws" />)
    expect(screen.getAllByTestId('permission-item')).toHaveLength(1)
  })

  it('only shows items for sessions matching this workspace', () => {
    mockSessions.push(makeSession({ shortId: 'sess-1', workspaceDir: '/home/user/my-ws' }))
    mockSessions.push(makeSession({ shortId: 'sess-other', workspaceDir: '/home/user/other-ws' }))
    mockQueues['sess-1'] = [makeRequest({ shortId: 'sess-1', requestId: 'aaaaa' })]
    mockQueues['sess-other'] = [makeRequest({ shortId: 'sess-other', requestId: 'bbbbb' })]

    render(<PermissionScroll workspaceSlug="my-ws" />)
    // Only sess-1 matches my-ws path
    expect(screen.getAllByTestId('permission-item')).toHaveLength(1)
    expect(screen.getByTestId('permission-item').getAttribute('data-request-id')).toBe('aaaaa')
  })

  it('sorts requests by receivedAt ascending (oldest first = index 0 = isActive)', () => {
    mockSessions.push(makeSession())
    const now = Date.now()
    mockQueues['sess-1'] = [
      makeRequest({ requestId: 'newer', receivedAt: now + 1000 }),
      makeRequest({ requestId: 'older', receivedAt: now - 1000 }),
    ]

    render(<PermissionScroll workspaceSlug="my-ws" />)
    const items = screen.getAllByTestId('permission-item')
    expect(items[0].getAttribute('data-request-id')).toBe('older')
    expect(items[0].getAttribute('data-active')).toBe('true')
    expect(items[1].getAttribute('data-active')).toBe('false')
  })

  it('shows badge count equal to number of pending requests', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [
      makeRequest({ requestId: 'aaaaa' }),
      makeRequest({ requestId: 'bbbbb' }),
    ]

    render(<PermissionScroll workspaceSlug="my-ws" />)
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('has aria-label with count when pending', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    const { container } = render(<PermissionScroll workspaceSlug="my-ws" />)
    const root = container.firstElementChild
    expect(root?.getAttribute('aria-label')).toContain('1 permission request')
  })

  it('calls sendVerdict when onVerdict is triggered', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    render(<PermissionScroll workspaceSlug="my-ws" />)
    fireEvent.click(screen.getByText('Allow'))
    expect(mockSendVerdict).toHaveBeenCalledWith('sess-1', 'abcde', 'allow')
  })

  it('only first item has isActive=true', () => {
    mockSessions.push(makeSession())
    const now = Date.now()
    mockQueues['sess-1'] = [
      makeRequest({ requestId: 'first', receivedAt: now }),
      makeRequest({ requestId: 'second', receivedAt: now + 100 }),
      makeRequest({ requestId: 'third', receivedAt: now + 200 }),
    ]

    render(<PermissionScroll workspaceSlug="my-ws" />)
    const items = screen.getAllByTestId('permission-item')
    expect(items[0].getAttribute('data-active')).toBe('true')
    expect(items[1].getAttribute('data-active')).toBe('false')
    expect(items[2].getAttribute('data-active')).toBe('false')
  })

  it('renders nothing visible when workspace slug does not match any workspace', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    const { container } = render(<PermissionScroll workspaceSlug="unknown-ws" />)
    // No match — invisible spacer only
    expect(container.querySelectorAll('[data-testid="permission-item"]')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// PermissionButton tests
// ---------------------------------------------------------------------------

describe('PermissionButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMocks()
  })

  it('returns null when no requests pending', () => {
    const { container } = render(<PermissionButton workspaceSlug="my-ws" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders trigger button with count badge when pending', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    render(<PermissionButton workspaceSlug="my-ws" />)
    expect(screen.getByRole('button', { name: /pending permission/i })).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('shows "pending permissions" plural for multiple requests', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [
      makeRequest({ requestId: 'aaaaa' }),
      makeRequest({ requestId: 'bbbbb' }),
    ]

    render(<PermissionButton workspaceSlug="my-ws" />)
    expect(screen.getByText(/2 pending permissions/i)).toBeTruthy()
  })

  it('auto-expands when requests are present (useEffect)', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    render(<PermissionButton workspaceSlug="my-ws" />)
    // useEffect auto-expands on first request — panel should be open
    expect(screen.getByRole('region', { name: /pending permission requests/i })).toBeTruthy()
  })

  it('clicking trigger toggles panel closed then open', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    render(<PermissionButton workspaceSlug="my-ws" />)
    // Panel auto-opens via useEffect
    const trigger = screen.getByRole('button', { name: /pending permission/i })

    // Click to collapse
    fireEvent.click(trigger)
    expect(screen.queryByRole('region')).toBeNull()

    // Click to expand again
    fireEvent.click(trigger)
    expect(screen.getByRole('region', { name: /pending permission requests/i })).toBeTruthy()
  })

  it('trigger has aria-expanded reflecting panel state', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    render(<PermissionButton workspaceSlug="my-ws" />)
    const trigger = screen.getByRole('button', { name: /pending permission/i })
    // Auto-expanded by useEffect
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('calls sendVerdict when onVerdict triggered in panel', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    render(<PermissionButton workspaceSlug="my-ws" />)
    // Panel auto-expands; mock renders buttons with text "Allow" and "Deny"
    // Use getAllByRole to handle multiple buttons, find "Deny" specifically
    const denyButton = screen.getAllByRole('button').find((b) => b.textContent === 'Deny')
    expect(denyButton).toBeTruthy()
    fireEvent.click(denyButton!)
    expect(mockSendVerdict).toHaveBeenCalledWith('sess-1', 'abcde', 'deny')
  })

  it('only sessions matching workspace path are shown', () => {
    mockSessions.push(makeSession({ shortId: 'sess-1', workspaceDir: '/home/user/my-ws' }))
    mockSessions.push(makeSession({ shortId: 'sess-other', workspaceDir: '/home/user/other-ws' }))
    mockQueues['sess-1'] = [makeRequest({ shortId: 'sess-1', requestId: 'aaaaa' })]
    mockQueues['sess-other'] = [makeRequest({ shortId: 'sess-other', requestId: 'bbbbb' })]

    render(<PermissionButton workspaceSlug="my-ws" />)
    // Panel auto-expands — only sess-1 items visible (one mock item = 2 Allow/Deny buttons)
    const permItems = screen.getAllByTestId('permission-item')
    expect(permItems).toHaveLength(1)
    expect(permItems[0].getAttribute('data-request-id')).toBe('aaaaa')
  })

  it('returns null when workspace slug does not match any workspace', () => {
    mockSessions.push(makeSession())
    mockQueues['sess-1'] = [makeRequest()]

    const { container } = render(<PermissionButton workspaceSlug="unknown-ws" />)
    expect(container.firstChild).toBeNull()
  })
})
