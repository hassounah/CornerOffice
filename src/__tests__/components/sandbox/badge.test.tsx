import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const openExplorer = vi.fn()
vi.mock('../../../renderer/utils/code-explorer-nav', () => ({ useOpenCodeExplorer: () => openExplorer }))

import { SandboxTag } from '../../../renderer/components/sandbox/SandboxTag'
import { SandboxBadge } from '../../../renderer/components/sandbox/SandboxBadge'
import { UnmergedDot } from '../../../renderer/components/sandbox/UnmergedDot'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import type { SandboxStatus, SandboxEnvironment } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// SandboxTag, SandboxBadge and UnmergedDot — step 5.3 (TRD §3.15.2, UX-H3,
// UX-M3, M3, SEC-H4). Every badge variant, Review's explorer options, and the
// dot's visibility and 3-name cap.
// ---------------------------------------------------------------------------

const ENV_OK: SandboxEnvironment = { docker: 'ok', dockerVersion: '28.0.1', image: { state: 'ready', builtAt: null, sizeBytes: null } }

function makeStatus(overrides: { session?: Partial<SandboxStatus['session']>; git?: SandboxStatus['git']; channel?: SandboxStatus['channel']; exists?: boolean } = {}): SandboxStatus {
  return {
    workspaceSlug: 'ws',
    eligibility: { ok: true, baseBranch: 'main', warnings: [] },
    exists: overrides.exists ?? true,
    container: 'running',
    worktree: 'ready',
    session: { state: 'running', permissionMode: 'skip', networkMode: 'allowlist', lastExit: null, ...overrides.session },
    git: overrides.git === undefined ? { branch: 'feat/a', headShort: 'abc1234', ahead: 2, dirtyCount: 0, base: 'main' } : overrides.git,
    recreatePending: false,
    recreatePlan: null,
    channel: overrides.channel ?? 'connected',
  }
}

function setStore(status: SandboxStatus | undefined, extra: Partial<ReturnType<typeof useSandboxStore.getState>> = {}): void {
  useSandboxStore.setState({
    environment: ENV_OK,
    status: status ? { ws: status } : {},
    summaries: {},
    blocked: {},
    dismissedExit: {},
    ...extra,
  })
}

beforeEach(() => {
  openExplorer.mockClear()
  setStore(undefined)
})

describe('SandboxTag', () => {
  it.each(['office', 'realm'] as const)('shows "Sandbox" with an accessible label naming the workspace (%s)', (skin) => {
    const { container } = render(<SandboxTag workspace="my-ws" skin={skin} />)
    expect(container).toHaveTextContent('Sandbox (from the sandbox for my-ws)')
  })
})

describe('SandboxBadge', () => {
  it('renders nothing without a status, and only an empty live region for an idle sandbox with no flags', () => {
    const { container, rerender } = render(<SandboxBadge slug="ws" />)
    expect(container).toBeEmptyDOMElement()

    setStore(makeStatus({ session: { state: 'idle' } }))
    rerender(<SandboxBadge slug="ws" />)
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('keeps one persistent polite live region that announces each transition', () => {
    setStore(makeStatus({ session: { state: 'idle' } }))
    const { rerender } = render(<SandboxBadge slug="ws" />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')

    const announce = (state: 'preparing' | 'running' | 'ending' | 'stop-unconfirmed'): string => {
      act(() => setStore(makeStatus({ session: { state } })))
      rerender(<SandboxBadge slug="ws" />)
      expect(screen.getByRole('status')).toBe(region) // the same node, so the change is announced
      return region.textContent ?? ''
    }
    expect(announce('preparing')).toBe('Sandbox starting')
    expect(announce('running')).toBe('Sandbox running')
    expect(announce('ending')).toBe('Sandbox ending')
    expect(announce('stop-unconfirmed')).toBe('Sandbox is still stopping')
  })

  it('only one of the full and compact badges owns a live region, so a change is announced once', () => {
    setStore(makeStatus({ session: { state: 'preparing' } }))
    render(
      <>
        <SandboxBadge slug="ws" />
        <SandboxBadge slug="ws" compact />
      </>,
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getAllByRole('group')).toHaveLength(2) // both still show their chips
  })

  it('a compact badge on its own owns the live region (terminal overlay opened with no full badge)', () => {
    setStore(makeStatus({ session: { state: 'preparing' } }))
    render(<SandboxBadge slug="ws" compact />)
    expect(screen.getByRole('status')).toHaveTextContent('Sandbox starting')
  })

  it('unmounting the owner hands the live region to the remaining badge', () => {
    setStore(makeStatus({ session: { state: 'preparing' } }))
    const { rerender } = render(
      <>
        <SandboxBadge slug="ws" key="full" />
        <SandboxBadge slug="ws" key="compact" compact />
      </>,
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)

    rerender(<SandboxBadge slug="ws" key="compact" compact />)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Sandbox starting')
  })

  it('ownership is per workspace: badges for different slugs each announce', () => {
    setStore(makeStatus({ session: { state: 'preparing' } }))
    useSandboxStore.setState({ status: { ws: makeStatus({ session: { state: 'preparing' } }), other: makeStatus({ session: { state: 'running' } }) } })
    render(
      <>
        <SandboxBadge slug="ws" />
        <SandboxBadge slug="other" />
      </>,
    )
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('announce can be forced either way', () => {
    setStore(makeStatus({ session: { state: 'idle' } }))
    const { rerender } = render(<SandboxBadge slug="ws" announce={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    rerender(<SandboxBadge slug="ws" compact announce />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('announces Stopped unexpectedly and Docker unavailable', () => {
    setStore(makeStatus({ session: { state: 'idle', lastExit: { kind: 'unexpected', reason: 'exited', at: 't1' } } }))
    const { rerender } = render(<SandboxBadge slug="ws" />)
    expect(screen.getByRole('status')).toHaveTextContent('Sandbox exited with a problem: The session exited')

    act(() => setStore(makeStatus({ session: { state: 'idle' } }), { environment: { ...ENV_OK, docker: 'daemon-down' } }))
    rerender(<SandboxBadge slug="ws" />)
    expect(screen.getByRole('status')).toHaveTextContent('Docker unavailable for the sandbox')
  })

  it.each([
    ['Docker unavailable', 'Start Docker, then press Check again in Sandbox settings.'],
    ['Channel: unavailable', 'End it and start a new one.'],
    ['Stopped unexpectedly', 'Start it again. Details are in the app log (README, Sandbox Sessions, Troubleshooting).'],
    ['Still stopping, retrying.', "Start stays blocked until it does."],
    ['Channel: plugin update needed', 'Update the Corner Office plugin'],
  ])('the %s chip carries its next step as a tooltip and an accessible description', (label, hintPart) => {
    const overrides: Record<string, () => void> = {
      'Docker unavailable': () => setStore(makeStatus({ session: { state: 'idle' } }), { environment: { ...ENV_OK, docker: 'daemon-down' } }),
      'Channel: unavailable': () => setStore(makeStatus({ channel: 'unavailable' })),
      'Stopped unexpectedly': () => setStore(makeStatus({ session: { state: 'idle', lastExit: { kind: 'unexpected', reason: 'exited', at: 't1' } } })),
      'Still stopping, retrying.': () => setStore(makeStatus({ session: { state: 'stop-unconfirmed' } })),
      'Channel: plugin update needed': () => setStore(makeStatus({ channel: 'plugin-outdated' })),
    }
    overrides[label]()
    render(<SandboxBadge slug="ws" />)
    const chip = screen
      .getAllByText(label, { exact: false })
      .map((el) => el.closest('[aria-describedby]'))
      .find((el) => el !== null) as HTMLElement
    expect(chip.getAttribute('title')).toContain(hintPart)
    const description = document.getElementById(chip.getAttribute('aria-describedby') ?? '')
    expect(description).toHaveTextContent(hintPart)
  })

  it('the Docker unavailable hint names The Armory in Realm, and Sandbox settings in Office', () => {
    setStore(makeStatus({ session: { state: 'idle' } }), { environment: { ...ENV_OK, docker: 'daemon-down' } })
    const { unmount } = render(<SandboxBadge slug="ws" skin="realm" />)
    const realmChip = screen.getByText('Docker unavailable').closest('[aria-describedby]') as HTMLElement
    expect(realmChip.getAttribute('title')).toBe('Start Docker, then press Check again in The Armory.')
    unmount()
    render(<SandboxBadge slug="ws" />)
    const officeChip = screen.getByText('Docker unavailable').closest('[aria-describedby]') as HTMLElement
    expect(officeChip.getAttribute('title')).toBe('Start Docker, then press Check again in Sandbox settings.')
  })

  it('shows branch and ahead count for a running session', () => {
    setStore(makeStatus())
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByRole('group', { name: 'Sandbox status' })).toHaveTextContent('Sandbox · feat/a · +2')
  })

  it('shows "detached" when HEAD is detached', () => {
    setStore(makeStatus({ git: { branch: null, headShort: 'abc', ahead: 0, dirtyCount: 0, base: 'main' } }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByRole('group')).toHaveTextContent('Sandbox · detached · +0')
  })

  it('shows just "Sandbox" while git is not known yet, and "Starting…" while preparing', () => {
    setStore(makeStatus({ git: null }))
    const { rerender } = render(<SandboxBadge slug="ws" />)
    expect(screen.getByRole('group')).toHaveTextContent(/^Sandbox/)
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()

    setStore(makeStatus({ session: { state: 'preparing' } }))
    rerender(<SandboxBadge slug="ws" />)
    expect(screen.getByRole('group')).toHaveTextContent('Sandbox · Starting…')
  })

  it('renders an invisible-character branch name visibly (review-safe)', () => {
    setStore(makeStatus({ git: { branch: 'feat/a‮b', headShort: 'abc', ahead: 0, dirtyCount: 0, base: 'main' } }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByRole('group').textContent).not.toContain('‮')
  })

  it('shows the uncommitted count only when dirty', () => {
    setStore(makeStatus({ git: { branch: 'b', headShort: 'x', ahead: 0, dirtyCount: 3, base: 'main' } }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByText('● 3 uncommitted')).toBeInTheDocument()
  })

  it('shows "Unrestricted network" for open mode only', () => {
    setStore(makeStatus({ session: { networkMode: 'open' } }))
    const { rerender } = render(<SandboxBadge slug="ws" />)
    expect(screen.getByText('Unrestricted network')).toBeInTheDocument()

    setStore(makeStatus())
    rerender(<SandboxBadge slug="ws" />)
    expect(screen.queryByText('Unrestricted network')).toBeNull()
  })

  it.each([
    ['plugin-outdated', 'Channel: plugin update needed'],
    ['unavailable', 'Channel: unavailable'],
  ] as const)('shows "%s" channel state as "%s"', (channel, text) => {
    setStore(makeStatus({ channel }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it.each(['connected', 'connecting', 'none'] as const)('shows no channel warning when the channel is %s', (channel) => {
    setStore(makeStatus({ channel }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.queryByText(/Channel:/)).toBeNull()
  })

  it('shows a Blocked count, as a button when a handler is given', async () => {
    const blocked = [{ domain: 'a.dev', count: 1, firstSeen: 't', lastSeen: 't' }, { domain: 'b.dev', count: 1, firstSeen: 't', lastSeen: 't' }]
    setStore(makeStatus(), { blocked: { ws: blocked } })
    const onOpenBlocked = vi.fn()
    const { rerender } = render(<SandboxBadge slug="ws" />)
    expect(screen.getByText('Blocked 2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Blocked 2' })).toBeNull()

    rerender(<SandboxBadge slug="ws" onOpenBlocked={onOpenBlocked} />)
    await userEvent.click(screen.getByRole('button', { name: 'Blocked 2' }))
    expect(onOpenBlocked).toHaveBeenCalledTimes(1)
  })

  it('shows "Ending…" during ending', () => {
    setStore(makeStatus({ session: { state: 'ending' } }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByText('Ending…')).toBeInTheDocument()
  })

  it('shows the retry chip during stop-unconfirmed', () => {
    setStore(makeStatus({ session: { state: 'stop-unconfirmed' } }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByText('Still stopping, retrying.')).toBeInTheDocument()
    expect(screen.queryByText('Ending…')).not.toBeInTheDocument()
  })

  it('shows "Docker unavailable" when the environment is not ok and a sandbox exists', () => {
    setStore(makeStatus({ session: { state: 'idle' } }), { environment: { ...ENV_OK, docker: 'daemon-down' } })
    const { rerender } = render(<SandboxBadge slug="ws" />)
    expect(screen.getByText('Docker unavailable')).toBeInTheDocument()

    setStore(makeStatus({ session: { state: 'idle' }, exists: false }), { environment: { ...ENV_OK, docker: 'daemon-down' } })
    rerender(<SandboxBadge slug="ws" />)
    expect(screen.queryByText('Docker unavailable')).toBeNull()
  })

  it.each([
    ['docker-unavailable', 'Stopped unexpectedly · Docker unavailable'],
    ['exited', 'Stopped unexpectedly · The session exited'],
  ] as const)('shows "Stopped unexpectedly" with the reason (%s)', (reason, text) => {
    setStore(makeStatus({ session: { state: 'idle', lastExit: { kind: 'unexpected', reason, at: 't1' } } }))
    render(<SandboxBadge slug="ws" />)
    expect(screen.getByText((_, el) => el?.textContent?.startsWith(text) === true && el.tagName === 'SPAN')).toBeInTheDocument()
  })

  it('shows "Docker unavailable" once when the exit reason and the environment both say so', () => {
    setStore(makeStatus({ session: { state: 'idle', lastExit: { kind: 'unexpected', reason: 'docker-unavailable', at: 't1' } } }), {
      environment: { ...ENV_OK, docker: 'daemon-down' },
    })
    render(<SandboxBadge slug="ws" />)
    const chips = screen.getByRole('group').textContent?.replace(screen.getByRole('status').textContent ?? '', '')
    expect(chips?.match(/Docker unavailable/g)).toHaveLength(1)
  })

  it.each(['office', 'realm'] as const)('Review, Blocked and Dismiss have a visible focus style (%s)', (skin) => {
    setStore(makeStatus({ session: { lastExit: { kind: 'unexpected', reason: 'exited', at: 't1' } } }), {
      blocked: { ws: [{ domain: 'a.dev', count: 1, firstSeen: 't', lastSeen: 't' }] },
    })
    render(<SandboxBadge slug="ws" skin={skin} onOpenBlocked={() => {}} />)
    for (const name of ['Review', 'Blocked 1', 'Dismiss stopped-unexpectedly notice']) {
      expect(screen.getByRole('button', { name }).className).toContain('focus-visible:outline')
    }
  })

  it('Dismiss hides the stopped notice until a new unexpected exit', async () => {
    setStore(makeStatus({ session: { state: 'idle', lastExit: { kind: 'unexpected', reason: 'exited', at: 't1' } } }))
    const { container } = render(<SandboxBadge slug="ws" />)

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss stopped-unexpectedly notice' }))
    expect(container.querySelector('[role="group"]')).toBeNull()

    act(() => setStore(makeStatus({ session: { state: 'idle', lastExit: { kind: 'unexpected', reason: 'exited', at: 't2' } } }), { dismissedExit: { ws: 't1' } }))
    expect(screen.getByRole('button', { name: 'Dismiss stopped-unexpectedly notice' })).toBeInTheDocument()
  })

  it('Review opens the explorer on the sandbox root with the §3.10 options', async () => {
    setStore(makeStatus())
    render(<SandboxBadge slug="ws" />)

    await userEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(openExplorer).toHaveBeenCalledWith('ws', { root: 'sandbox', entry: 'review', changedOnly: true, baseline: 'branch', expectedBranch: 'feat/a' })
  })

  it('Review passes a null expected branch when detached', async () => {
    setStore(makeStatus({ git: { branch: null, headShort: 'x', ahead: 0, dirtyCount: 0, base: 'main' } }))
    render(<SandboxBadge slug="ws" />)
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(openExplorer).toHaveBeenCalledWith('ws', expect.objectContaining({ expectedBranch: null }))
  })

  it('compact keeps the label, Review and every warning but drops uncommitted and Blocked', () => {
    setStore(
      makeStatus({ session: { networkMode: 'open' }, channel: 'unavailable', git: { branch: 'b', headShort: 'x', ahead: 1, dirtyCount: 4, base: 'main' } }),
      { blocked: { ws: [{ domain: 'a.dev', count: 1, firstSeen: 't', lastSeen: 't' }] } },
    )
    render(<SandboxBadge slug="ws" compact />)

    expect(screen.getByRole('group')).toHaveTextContent('Sandbox · b · +1')
    expect(screen.getByText('Unrestricted network')).toBeInTheDocument()
    expect(screen.getByText('Channel: unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument()
    expect(screen.queryByText(/uncommitted/)).toBeNull()
    expect(screen.queryByText(/Blocked/)).toBeNull()
  })

  it('renders in the realm skin with the same copy', () => {
    setStore(makeStatus({ session: { networkMode: 'open' }, channel: 'plugin-outdated', git: { branch: 'b', headShort: 'x', ahead: 1, dirtyCount: 2, base: 'main' } }), {
      blocked: { ws: [{ domain: 'a.dev', count: 1, firstSeen: 't', lastSeen: 't' }] },
    })
    render(<SandboxBadge slug="ws" skin="realm" />)

    const text = screen.getByRole('group').textContent
    for (const expected of ['Sandbox · b · +1', 'Review', '● 2 uncommitted', 'Unrestricted network', 'Channel: plugin update needed', 'Blocked 1']) {
      expect(text).toContain(expected)
    }
  })

  it('realm skin also renders the degraded states', () => {
    setStore(makeStatus({ session: { state: 'ending', lastExit: { kind: 'unexpected', reason: 'exited', at: 't1' } }, channel: 'unavailable' }), {
      environment: { ...ENV_OK, docker: 'daemon-down' },
    })
    render(<SandboxBadge slug="ws" skin="realm" />)
    const text = screen.getByRole('group').textContent
    for (const expected of ['Ending…', 'Docker unavailable', 'Stopped unexpectedly', 'Channel: unavailable']) expect(text).toContain(expected)
  })
})

describe('UnmergedDot', () => {
  function setBranches(branches: string[] | undefined): void {
    useSandboxStore.setState({ summaries: branches ? { ws: { exists: true, running: false, unmergedBranches: branches } } : {} })
  }

  it('is hidden with no summary or no unmerged branches', () => {
    const { container, rerender } = render(<UnmergedDot slug="ws" />)
    expect(container).toBeEmptyDOMElement()

    setBranches([])
    rerender(<UnmergedDot slug="ws" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is visible even with no session running, and names the branches in its label', () => {
    setBranches(['feat/a', 'feat/b'])
    render(<UnmergedDot slug="ws" />)
    expect(screen.getByRole('img', { name: 'Unmerged sandbox work: feat/a, feat/b' })).toBeInTheDocument()
  })

  it('caps the names at three and counts the rest', () => {
    setBranches(['a', 'b', 'c', 'd', 'e'])
    render(<UnmergedDot slug="ws" />)
    const dot = screen.getByRole('img')
    expect(dot).toHaveAccessibleName('Unmerged sandbox work: a, b, c, +2 more')

    fireEvent.focus(dot)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Unmerged sandbox work: a, b, c, +2 more')
    expect(tooltip).not.toHaveTextContent(/, d/)
  })

  it('renders duplicate branch names without a duplicate-key warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setBranches(['dup', 'dup'])
    render(<UnmergedDot slug="ws" />)
    fireEvent.focus(screen.getByRole('img'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Unmerged sandbox work: dup, dup')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('exactly three branches have no "+N more"', () => {
    setBranches(['a', 'b', 'c'])
    render(<UnmergedDot slug="ws" />)
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('more')
  })

  it.each(['office', 'realm'] as const)('shows the tooltip on hover and on focus, hides on leave, blur and Escape (%s)', async (skin) => {
    setBranches(['feat/a'])
    render(<UnmergedDot slug="ws" skin={skin} />)
    const dot = screen.getByRole('img')
    expect(dot).toHaveAttribute('tabindex', '0')
    expect(screen.queryByRole('tooltip')).toBeNull()

    await userEvent.hover(dot)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(dot).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    await userEvent.unhover(dot)
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => dot.focus())
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.focus(dot)
    fireEvent.blur(dot)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('renders branch names with invisible characters visibly', () => {
    setBranches(['feat/a‮b'])
    render(<UnmergedDot slug="ws" />)
    fireEvent.focus(screen.getByRole('img'))
    expect(screen.getByRole('tooltip').textContent).not.toContain('‮')
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('‮')
  })
})
