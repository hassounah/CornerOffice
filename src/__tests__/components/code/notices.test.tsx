import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ExplorerNotice } from '../../../renderer/components/code/ExplorerNotice'
import { GitStateBanner } from '../../../renderer/components/code/GitStateBanner'
import {
  gitStateBannerCopy,
  oldGitVersionNotice,
  liveUpdatesLimitedNotice,
  LIVE_UPDATES_REASON,
} from '../../../renderer/components/code/notice-copy'
import { REPO_STATE_FIXTURES } from '../../helpers/repo-state-fixtures'

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// ExplorerNotice
// ---------------------------------------------------------------------------

describe('ExplorerNotice', () => {
  it('renders the message with role="status"', () => {
    render(<ExplorerNotice tone="info" message="Hello there" />)
    const el = screen.getByRole('status')
    expect(el).toHaveTextContent('Hello there')
  })

  it('renders no dismiss control by default', () => {
    render(<ExplorerNotice tone="warning" message="Careful" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('calls onDismiss exactly once when the dismiss control is clicked', () => {
    const onDismiss = vi.fn()
    render(<ExplorerNotice tone="info" message="Dismiss me" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('auto-hides after autoHideMs (the transient "Reloaded from disk" case)', () => {
    vi.useFakeTimers()
    render(<ExplorerNotice tone="info" message="Reloaded from disk" autoHideMs={4000} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reloaded from disk')

    act(() => {
      vi.advanceTimersByTime(3999)
    })
    expect(screen.getByRole('status')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not auto-hide when autoHideMs is omitted (a persistent banner)', () => {
    vi.useFakeTimers()
    render(<ExplorerNotice tone="warning" message="Persistent" />)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Persistent')
  })

  it('becomes visible again for a new message after a previous auto-hide fired (a reused instance)', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ExplorerNotice tone="info" message="First" autoHideMs={4000} />)
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('status')).toBeNull()

    rerender(<ExplorerNotice tone="info" message="Second" autoHideMs={4000} />)
    expect(screen.getByRole('status')).toHaveTextContent('Second')
  })

  // --- Step 2.13 extension: danger tone, role, actions ----------------------

  it('defaults to role="status" when role is omitted', () => {
    render(<ExplorerNotice tone="info" message="Default role" />)
    expect(screen.getByRole('status')).toHaveTextContent('Default role')
  })

  it('renders role="alert" when requested (the branch-mismatch banner, §3.8.3)', () => {
    render(<ExplorerNotice tone="warning" role="alert" message="Interrupting" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Interrupting')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('accepts a danger tone', () => {
    render(<ExplorerNotice tone="danger" message="Danger notice" />)
    expect(screen.getByRole('status')).toHaveTextContent('Danger notice')
  })

  it('renders a ReactNode message (e.g. embedding another component)', () => {
    render(<ExplorerNotice tone="warning" message={<strong>Bold part</strong>} />)
    expect(screen.getByText('Bold part').tagName).toBe('STRONG')
  })

  it('renders action buttons and fires their onClick exactly once each', () => {
    const onReload = vi.fn()
    const onKeepMine = vi.fn()
    render(
      <ExplorerNotice
        tone="warning"
        message="Changed on disk"
        actions={[
          { label: 'Reload', onClick: onReload },
          { label: 'Keep mine', onClick: onKeepMine },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onKeepMine).toHaveBeenCalledTimes(1)
  })

  it('renders no action buttons when actions is omitted or empty', () => {
    render(<ExplorerNotice tone="info" message="No actions" actions={[]} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  // --- Fix #127: stable `id` instead of ReactNode reference equality -------

  it('with a stable id, a rebuilt ReactNode message (new reference, same content) does not un-hide after auto-hide fires', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <ExplorerNotice tone="info" id="x" autoHideMs={4000} message={<span>same content</span>} />,
    )
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('status')).toBeNull()

    // A brand-new element (different reference), but the same id.
    rerender(<ExplorerNotice tone="info" id="x" autoHideMs={4000} message={<span>same content</span>} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('without an id, the same rebuilt-ReactNode re-render DOES un-hide (the documented reference-equality fallback)', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ExplorerNotice tone="info" autoHideMs={4000} message={<span>same content</span>} />)
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('status')).toBeNull()

    rerender(<ExplorerNotice tone="info" autoHideMs={4000} message={<span>same content</span>} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('changing the id un-hides and restarts the auto-hide timer', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ExplorerNotice tone="info" id="a" autoHideMs={4000} message="first" />)
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('status')).toBeNull()

    rerender(<ExplorerNotice tone="info" id="b" autoHideMs={4000} message="second" />)
    expect(screen.getByRole('status')).toHaveTextContent('second')
  })
})

// ---------------------------------------------------------------------------
// GitStateBanner — one test per RepoState (TRD §3.9.1), copy snapshots
// ---------------------------------------------------------------------------

describe('GitStateBanner — RepoState matrix', () => {
  it('renders nothing when repo is null', () => {
    const { container } = render(<GitStateBanner repo={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing for state 'git' with no degraded condition", () => {
    const { container } = render(<GitStateBanner repo={REPO_STATE_FIXTURES.git} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the not-git banner', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.notGit} />)
    const expected = gitStateBannerCopy('not-git', null)!
    expect(screen.getByRole('status')).toHaveTextContent(expected.message)
  })

  it('renders the git-unavailable (not found) banner', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.gitUnavailableNotFound} />)
    const expected = gitStateBannerCopy('git-unavailable', null)!
    expect(screen.getByRole('status')).toHaveTextContent(expected.message)
  })

  it('renders the git-unavailable (found inside a workspace) banner', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.gitUnavailableInsideWorkspace} />)
    const expected = gitStateBannerCopy('git-unavailable', 'git found inside a workspace')!
    expect(screen.getByRole('status')).toHaveTextContent(expected.message)
  })

  it('renders the git-too-old banner', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.gitTooOld} />)
    const expected = gitStateBannerCopy('git-too-old', null)!
    expect(screen.getByRole('status')).toHaveTextContent(expected.message)
  })

  it('renders the git-untrusted banner', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.gitUntrusted} />)
    const expected = gitStateBannerCopy('git-untrusted', null)!
    expect(screen.getByRole('status')).toHaveTextContent(expected.message)
  })

  it('renders the git-unsafe banner', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.gitUnsafe} />)
    const expected = gitStateBannerCopy('git-unsafe', null)!
    expect(screen.getByRole('status')).toHaveTextContent(expected.message)
  })

  it('renders the root-mismatch banner', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.rootMismatch} />)
    const expected = gitStateBannerCopy('root-mismatch', null)!
    expect(screen.getByRole('status')).toHaveTextContent(expected.message)
  })
})

describe('GitStateBanner — pre-2.39.1 and live-updates-limited variants', () => {
  it('renders the pre-2.39.1 info notice when a gitVersion is supplied, and it is dismissible', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.preOldGitVersion} gitVersion="2.34.1" />)
    const expected = oldGitVersionNotice('2.34.1')
    const notices = screen.getAllByRole('status')
    // Substring match, not exact equality — the dismiss button's own text
    // ("×") is also part of the notice element's textContent.
    expect(notices.some((n) => n.textContent?.includes(expected))).toBe(true)

    const dismissButton = screen.getByRole('button', { name: /dismiss/i })
    fireEvent.click(dismissButton)
    expect(screen.queryByText(expected, { exact: false })).toBeNull()
  })

  it('renders no pre-2.39.1 notice when gitVersion is not supplied', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.preOldGitVersion} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the live-updates-limited notice when liveGitUpdates is false and a reason is given', () => {
    render(
      <GitStateBanner
        repo={REPO_STATE_FIXTURES.liveUpdatesLimited}
        liveUpdatesReason={LIVE_UPDATES_REASON.UNUSUAL_GIT_LAYOUT}
      />,
    )
    const expected = liveUpdatesLimitedNotice(LIVE_UPDATES_REASON.UNUSUAL_GIT_LAYOUT)
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('renders no live-updates notice when liveGitUpdates is true', () => {
    render(<GitStateBanner repo={REPO_STATE_FIXTURES.git} liveUpdatesReason={LIVE_UPDATES_REASON.FOLDER_CAP} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('can render the state banner and the pre-2.39.1 notice together', () => {
    const repo = { ...REPO_STATE_FIXTURES.gitUnsafe, gitVersionInfo: 'pre-2.39.1' as const }
    render(<GitStateBanner repo={repo} gitVersion="2.34.1" />)
    const stateExpected = gitStateBannerCopy('git-unsafe', null)!
    const versionExpected = oldGitVersionNotice('2.34.1')
    const notices = screen.getAllByRole('status').map((n) => n.textContent ?? '')
    expect(notices.some((t) => t.includes(stateExpected.message))).toBe(true)
    expect(notices.some((t) => t.includes(versionExpected))).toBe(true)
  })
})
