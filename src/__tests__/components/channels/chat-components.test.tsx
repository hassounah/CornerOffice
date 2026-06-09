import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ChannelSession, ChatMessage as ChatMessageType } from '@main/types/channels'
import type { ChannelsState } from '../../../renderer/stores/channels-store'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../renderer/stores/channels-store', () => ({
  useChannelsStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      sessions: [],
      messages: {},
      activeSessionId: null,
      setActiveSession: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    })
  ),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ workspaces: [] })
  ),
}))

import { useChannelsStore } from '../../../renderer/stores/channels-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { ChatMessage } from '../../../renderer/components/channels/ChatMessage'
import { SessionSelector } from '../../../renderer/components/channels/SessionSelector'
import { ChatPanel } from '../../../renderer/components/channels/ChatPanel'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    shortId: 'sess-1',
    pid: 9999,
    workspaceDir: '/home/user/project',
    workspaceName: 'project',
    channelPort: 8080,
    channelToken: 'tok-abc',
    connectionState: 'connected',
    ...overrides,
  }
}

function makeMessage(overrides: Partial<ChatMessageType> = {}): ChatMessageType {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    role: 'user',
    text: 'Hello!',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeChannelsState(overrides: Partial<ChannelsState> = {}): ChannelsState {
  return {
    sessions: [],
    messages: {},
    activeSessionId: null,
    loading: false,
    error: null,
    setActiveSession: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    fetchSessions: vi.fn().mockResolvedValue(undefined),
    initListeners: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ChatMessage component
// ---------------------------------------------------------------------------

describe('ChatMessage', () => {
  it('renders user message with text', () => {
    render(<ChatMessage message={makeMessage({ role: 'user', text: 'User says hi' })} />)
    expect(screen.getByText('User says hi')).toBeDefined()
  })

  it('renders assistant message with text', () => {
    render(<ChatMessage message={makeMessage({ role: 'assistant', text: 'Assistant replies' })} />)
    expect(screen.getByText('Assistant replies')).toBeDefined()
  })

  it('shows (edited) label when editedAt is set', () => {
    render(<ChatMessage message={makeMessage({ editedAt: new Date().toISOString() })} />)
    expect(screen.getByText('(edited)')).toBeDefined()
  })

  it('does not show (edited) label when editedAt is absent', () => {
    render(<ChatMessage message={makeMessage()} />)
    expect(screen.queryByText('(edited)')).toBeNull()
  })

  it('renders timestamp in a time element', () => {
    const ts = '2024-01-15T10:30:00.000Z'
    render(<ChatMessage message={makeMessage({ timestamp: ts })} />)
    const el = document.querySelector('time')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('datetime')).toBe(ts)
  })
})

// ---------------------------------------------------------------------------
// SessionSelector component
// ---------------------------------------------------------------------------

describe('SessionSelector', () => {
  it('renders a select element', () => {
    render(
      <SessionSelector
        sessions={[makeSession()]}
        activeSessionId="sess-1"
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByRole('combobox')).toBeDefined()
  })

  it('lists all sessions as options', () => {
    const sessions = [
      makeSession({ shortId: 'sess-1', workspaceName: 'proj-a' }),
      makeSession({ shortId: 'sess-2', workspaceName: 'proj-b', channelPort: 8081 }),
    ]
    render(
      <SessionSelector sessions={sessions} activeSessionId="sess-1" onSelect={vi.fn()} />
    )
    expect(screen.getByRole('option', { name: /proj-a/ })).toBeDefined()
    expect(screen.getByRole('option', { name: /proj-b/ })).toBeDefined()
  })

  it('calls onSelect with session shortId on change', () => {
    const onSelect = vi.fn()
    const sessions = [
      makeSession({ shortId: 'sess-1', workspaceName: 'proj-a' }),
      makeSession({ shortId: 'sess-2', workspaceName: 'proj-b', channelPort: 8081 }),
    ]
    render(<SessionSelector sessions={sessions} activeSessionId="sess-1" onSelect={onSelect} />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'sess-2' } })
    expect(onSelect).toHaveBeenCalledWith('sess-2')
  })

  it('shows no-active-sessions option when empty', () => {
    render(<SessionSelector sessions={[]} activeSessionId={null} onSelect={vi.fn()} />)
    expect(screen.getByText('No active sessions')).toBeDefined()
  })

  it('includes branch name in label when present', () => {
    const sessions = [makeSession({ workspaceName: 'proj', branchName: 'main' })]
    render(<SessionSelector sessions={sessions} activeSessionId="sess-1" onSelect={vi.fn()} />)
    expect(screen.getByRole('option', { name: /proj · main/ })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// ChatPanel — empty state and connection status
// ---------------------------------------------------------------------------

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "No active sessions" empty state when no sessions match workspace', () => {
    vi.mocked(useWorkspaceStore).mockImplementation((selector) =>
      selector({
        workspaces: [{ slug: 'my-ws', path: '/home/user/project' }],
      } as Parameters<typeof selector>[0])
    )
    vi.mocked(useChannelsStore).mockImplementation((selector) =>
      selector(makeChannelsState() as Parameters<typeof selector>[0])
    )

    render(<ChatPanel workspaceSlug="my-ws" />)
    expect(screen.getByText('No active sessions')).toBeDefined()
  })

  it('shows connection status when session is active', () => {
    const session = makeSession({ connectionState: 'connected' })
    vi.mocked(useWorkspaceStore).mockImplementation((selector) =>
      selector({
        workspaces: [{ slug: 'my-ws', path: '/home/user/project' }],
      } as Parameters<typeof selector>[0])
    )
    vi.mocked(useChannelsStore).mockImplementation((selector) =>
      selector(makeChannelsState({ sessions: [session], activeSessionId: 'sess-1' }) as Parameters<typeof selector>[0])
    )

    render(<ChatPanel workspaceSlug="my-ws" />)
    expect(screen.getByText('Connected')).toBeDefined()
  })

  it('renders message list with role="log" and aria-live="polite"', () => {
    const session = makeSession()
    vi.mocked(useWorkspaceStore).mockImplementation((selector) =>
      selector({
        workspaces: [{ slug: 'my-ws', path: '/home/user/project' }],
      } as Parameters<typeof selector>[0])
    )
    vi.mocked(useChannelsStore).mockImplementation((selector) =>
      selector(makeChannelsState({ sessions: [session], messages: { 'sess-1': [] }, activeSessionId: 'sess-1' }) as Parameters<typeof selector>[0])
    )

    render(<ChatPanel workspaceSlug="my-ws" />)
    const log = document.querySelector('[role="log"]')
    expect(log).not.toBeNull()
    expect(log?.getAttribute('aria-live')).toBe('polite')
  })

  it('renders existing messages in the message list', () => {
    const session = makeSession()
    const msg = makeMessage({ text: 'Test message content' })
    vi.mocked(useWorkspaceStore).mockImplementation((selector) =>
      selector({
        workspaces: [{ slug: 'my-ws', path: '/home/user/project' }],
      } as Parameters<typeof selector>[0])
    )
    vi.mocked(useChannelsStore).mockImplementation((selector) =>
      selector(makeChannelsState({ sessions: [session], messages: { 'sess-1': [msg] }, activeSessionId: 'sess-1' }) as Parameters<typeof selector>[0])
    )

    render(<ChatPanel workspaceSlug="my-ws" />)
    expect(screen.getByText('Test message content')).toBeDefined()
  })

  it('disables input when connection state is not connected', () => {
    const session = makeSession({ connectionState: 'disconnected' })
    vi.mocked(useWorkspaceStore).mockImplementation((selector) =>
      selector({
        workspaces: [{ slug: 'my-ws', path: '/home/user/project' }],
      } as Parameters<typeof selector>[0])
    )
    vi.mocked(useChannelsStore).mockImplementation((selector) =>
      selector(makeChannelsState({ sessions: [session], activeSessionId: 'sess-1' }) as Parameters<typeof selector>[0])
    )

    render(<ChatPanel workspaceSlug="my-ws" />)
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
  })

  it('shows pipeline stage badge when pipelineStage is set', () => {
    const session = makeSession({ pipelineStage: 'implement' })
    vi.mocked(useWorkspaceStore).mockImplementation((selector) =>
      selector({
        workspaces: [{ slug: 'my-ws', path: '/home/user/project' }],
      } as Parameters<typeof selector>[0])
    )
    vi.mocked(useChannelsStore).mockImplementation((selector) =>
      selector(makeChannelsState({ sessions: [session], activeSessionId: 'sess-1' }) as Parameters<typeof selector>[0])
    )

    render(<ChatPanel workspaceSlug="my-ws" />)
    expect(screen.getByText(/implement/i)).toBeDefined()
  })
})
