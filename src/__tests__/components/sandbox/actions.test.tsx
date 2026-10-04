import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SandboxActions } from '../../../renderer/components/sandbox/SandboxActions'
import { useSandboxStore } from '../../../renderer/stores/sandbox-store'
import { useTerminalStore } from '../../../renderer/stores/terminal-store'
import { HAND_OFF_FAILURE_COPY, DELETE_FAILURE_COPY, SANDBOX_UNAVAILABLE_COPY, STILL_STOPPING, RECREATED_COPY } from '../../../renderer/utils/sandbox-copy'
import type { SandboxStatus, RecreatePlan } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// SandboxActions — step 5.5 (TRD §3.15.2, §3.16, H-B2, UX-C2): Hand off
// (clean, dirty, LOCKED + Retry), Delete (with and without uncommitted
// changes), Recreate through the dialog, and every control disabled with a
// reason while the sandbox is ending.
// ---------------------------------------------------------------------------

const api = {
  getStatus: vi.fn(),
  handOff: vi.fn(),
  previewDelete: vi.fn(),
  delete: vi.fn(),
  recreate: vi.fn(),
}
Object.defineProperty(window, 'cornerOffice', { value: { sandbox: api, terminal: {}, on: vi.fn(() => vi.fn()) }, writable: true, configurable: true })

const ok = <T,>(data: T) => ({ data, error: null })
const HASH = 'a'.repeat(64)

function plan(overrides: Partial<RecreatePlan> = {}): RecreatePlan {
  return { reason: 'image', specHash: HASH, newHostMounts: [], removedHostMounts: [], ...overrides }
}

function status(o: { state?: SandboxStatus['session']['state']; branch?: string | null; worktree?: SandboxStatus['worktree']; exists?: boolean; pending?: boolean; plan?: RecreatePlan | null } = {}): SandboxStatus {
  return {
    workspaceSlug: 'ws',
    eligibility: { ok: true, baseBranch: 'main', warnings: [] },
    exists: o.exists ?? true,
    container: 'stopped',
    worktree: o.worktree ?? 'ready',
    session: { state: o.state ?? 'idle', permissionMode: null, networkMode: null, lastExit: null },
    git: o.branch === undefined ? { branch: 'feat/a', headShort: 'abc', ahead: 1, dirtyCount: 0, base: 'main' } : o.branch === null ? { branch: null, headShort: 'abc', ahead: 0, dirtyCount: 0, base: 'main' } : { branch: o.branch, headShort: 'abc', ahead: 1, dirtyCount: 0, base: 'main' },
    recreatePending: o.pending ?? false,
    recreatePlan: o.plan ?? null,
    channel: 'none',
  }
}

function setup(s: SandboxStatus | null = status()): void {
  api.getStatus.mockResolvedValue(ok(s))
  useSandboxStore.setState({ status: s ? { ws: s } : {}, summaries: {} })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.handOff.mockResolvedValue(ok({ ok: true }))
  api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 0, unmergedBranches: [] }))
  api.delete.mockResolvedValue(ok({ ok: true }))
  api.recreate.mockResolvedValue(ok({ ok: true }))
  useTerminalStore.setState({ spawnError: {}, spawnFailure: {} })
  setup()
})

const button = (name: string) => screen.getByRole('button', { name })

describe('visibility', () => {
  it('renders nothing without a status, or when there is nothing to act on', () => {
    setup(null)
    const { container, unmount } = render(<SandboxActions slug="ws" />)
    expect(container).toBeEmptyDOMElement()
    unmount()

    setup(status({ exists: false, worktree: 'absent' }))
    const second = render(<SandboxActions slug="ws" />)
    expect(second.container).toBeEmptyDOMElement()
  })

  it('shows Hand off and Delete for an idle sandbox, and Recreate only when something needs recreating', () => {
    render(<SandboxActions slug="ws" />)
    expect(button('Hand off branch')).toBeInTheDocument()
    expect(button('Delete sandbox')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Recreate sandbox' })).toBeNull()
  })

  it.each([
    ['recreatePending', { pending: true }],
    ['a recreate plan', { plan: plan() }],
  ])('shows Recreate for %s', (_name, o) => {
    setup(status(o))
    render(<SandboxActions slug="ws" />)
    expect(button('Recreate sandbox')).toBeInTheDocument()
  })

  it('shows Recreate after a PORT_CONFLICT', () => {
    useTerminalStore.setState({ spawnFailure: { ws: 'PORT_CONFLICT' } })
    render(<SandboxActions slug="ws" />)
    expect(button('Recreate sandbox')).toBeInTheDocument()
  })

  it('hides Delete while a session exists, but keeps Hand off', () => {
    setup(status({ state: 'running' }))
    render(<SandboxActions slug="ws" />)
    expect(screen.queryByRole('button', { name: 'Delete sandbox' })).toBeNull()
    expect(button('Hand off branch')).toBeInTheDocument()
  })

  it('refreshes the status on mount', async () => {
    render(<SandboxActions slug="ws" />)
    await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalledWith('ws'))
  })
})

describe('Hand off', () => {
  it('a clean hand-off calls handOff with allowDirty false and says so', async () => {
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))

    expect(api.handOff).toHaveBeenCalledExactlyOnceWith('ws', false)
    expect(await screen.findByRole('status')).toHaveTextContent('Handed off. The branch is free to check out.')
  })

  it('DIRTY opens the confirm with the count; confirming hands off with allowDirty true', async () => {
    api.handOff.mockResolvedValueOnce(ok({ ok: false, code: 'DIRTY', dirtyCount: 3 }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('3 uncommitted changes will stay in the sandbox worktree, not on the branch. Hand off anyway?')
    expect(dialog).not.toHaveTextContent("The agent's next commits")

    await userEvent.click(within(dialog).getByRole('button', { name: 'Hand off anyway' }))
    expect(api.handOff).toHaveBeenLastCalledWith('ws', true)
    expect(await screen.findByRole('status')).toHaveTextContent('Handed off.')
  })

  it('uses the singular for one change', async () => {
    api.handOff.mockResolvedValueOnce(ok({ ok: false, code: 'DIRTY', dirtyCount: 1 }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('1 uncommitted change will stay')
  })

  it("adds the running-session line when a session is running", async () => {
    setup(status({ state: 'running' }))
    api.handOff.mockResolvedValueOnce(ok({ ok: false, code: 'DIRTY', dirtyCount: 2 }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent("The agent's next commits won't be on this branch.")
  })

  it('cancelling the dirty confirm hands nothing off', async () => {
    api.handOff.mockResolvedValueOnce(ok({ ok: false, code: 'DIRTY', dirtyCount: 2 }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))

    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.handOff).toHaveBeenCalledTimes(1)
  })

  it('LOCKED shows its copy with a Retry that tries again with the same flag', async () => {
    api.handOff.mockResolvedValueOnce(ok({ ok: false, code: 'LOCKED' }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The agent is using git right now. Try again in a moment.')

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(api.handOff).toHaveBeenCalledTimes(2)
    expect(api.handOff).toHaveBeenLastCalledWith('ws', false)
    expect(await screen.findByRole('status')).toHaveTextContent('Handed off.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['NOT_ON_BRANCH', 'NO_WORKTREE', 'SESSION_ENDING'] as const)('%s shows its fixed copy', async (code) => {
    api.handOff.mockResolvedValueOnce(ok({ ok: false, code }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))
    expect(await screen.findByRole('alert')).toHaveTextContent(HAND_OFF_FAILURE_COPY[code] as string)
  })

  it('shows the unavailable copy when main cannot be reached', async () => {
    api.handOff.mockResolvedValueOnce({ data: { data: null, error: { code: 'NOT_READY', message: 'x' } }, error: null })
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Hand off branch'))
    expect(await screen.findByRole('alert')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)
  })

  it('is aria-disabled with a reason when HEAD is detached, and when the worktree is not ready', async () => {
    setup(status({ branch: null }))
    const { unmount } = render(<SandboxActions slug="ws" />)
    let handOff = button('Hand off branch')
    expect(handOff).toHaveAttribute('aria-disabled', 'true')
    expect(handOff).not.toBeDisabled()
    fireEvent.focus(handOff)
    expect(screen.getByRole('tooltip')).toHaveTextContent(HAND_OFF_FAILURE_COPY.NOT_ON_BRANCH as string)
    await userEvent.click(handOff)
    expect(api.handOff).not.toHaveBeenCalled()
    unmount()

    setup(status({ worktree: 'corrupt' }))
    render(<SandboxActions slug="ws" />)
    handOff = button('Hand off branch')
    fireEvent.focus(handOff)
    expect(screen.getByRole('tooltip')).toHaveTextContent(HAND_OFF_FAILURE_COPY.NO_WORKTREE as string)
  })

  it('ignores a second click while one is in flight', async () => {
    let finish: (v: unknown) => void = () => {}
    api.handOff.mockReturnValue(new Promise((r) => { finish = r }))
    render(<SandboxActions slug="ws" />)

    await userEvent.click(button('Hand off branch'))
    await userEvent.click(button('Hand off branch')) // re-queried: DisabledReason wraps it while busy

    expect(api.handOff).toHaveBeenCalledTimes(1)
    finish(ok({ ok: true }))
  })
})

describe('Delete', () => {
  it('a clean sandbox: previews, confirms and deletes without the acknowledgement', async () => {
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 0, unmergedBranches: [] }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete the sandbox?')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(dialog).not.toHaveTextContent('will be lost')
    expect(dialog).not.toHaveTextContent('These branches stay')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(api.delete).toHaveBeenCalledExactlyOnceWith('ws', false)
  })

  it('lists the unmerged branches, which stay in the repository', async () => {
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 0, unmergedBranches: ['feat/a', 'feat/b'] }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('These branches stay in your repository; review or merge them first.')
    expect(dialog).toHaveTextContent('feat/a')
    expect(dialog).toHaveTextContent('feat/b')
  })

  it('renders branch names with invisible characters visibly (review-safe)', async () => {
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 0, unmergedBranches: ['feat/a‮b'] }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))
    expect((await screen.findByRole('alertdialog')).textContent).not.toContain('‮')
  })

  it('with uncommitted changes: Delete stays disabled until "I understand" is ticked, then acknowledges them', async () => {
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 4, unmergedBranches: [] }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('4 uncommitted changes will be lost.')
    const confirm = within(dialog).getByRole('button', { name: 'Delete' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).not.toBeDisabled()
    fireEvent.focus(confirm)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tick "I understand" first.')
    await userEvent.click(confirm)
    expect(api.delete).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'I understand' }))
    const enabled = within(dialog).getByRole('button', { name: 'Delete' })
    expect(enabled).not.toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(enabled)

    expect(api.delete).toHaveBeenCalledExactlyOnceWith('ws', true)
  })

  it('uses the singular for one uncommitted change', async () => {
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 1, unmergedBranches: [] }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('1 uncommitted change will be lost.')
  })

  it('focuses Cancel first, and Cancel and Escape delete nothing', async () => {
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await userEvent.click(button('Delete sandbox'))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('a session that started since the preview is refused with its copy, with no dialog', async () => {
    api.previewDelete.mockResolvedValue(ok({ sessionRunning: true, dirtyCount: 0, unmergedBranches: [] }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))

    expect(await screen.findByRole('alert')).toHaveTextContent(DELETE_FAILURE_COPY.SESSION_RUNNING)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it.each(['SESSION_RUNNING', 'DIRTY_NOT_ACKNOWLEDGED', 'FAILED'] as const)('a %s refusal from main shows its fixed copy', async (code) => {
    api.delete.mockResolvedValueOnce(ok({ ok: false, code }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(DELETE_FAILURE_COPY[code])
  })

  it('shows the unavailable copy when the preview cannot be fetched', async () => {
    api.previewDelete.mockResolvedValue({ data: { data: null, error: { code: 'NOT_READY', message: 'x' } }, error: null })
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))
    expect(await screen.findByRole('alert')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)
  })

  it('shows the unavailable copy when the delete itself cannot reach main', async () => {
    api.delete.mockResolvedValue({ data: { data: null, error: { code: 'NOT_READY', message: 'x' } }, error: null })
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Delete sandbox'))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)
  })
})

describe('Recreate', () => {
  it('always goes through the dialog; confirming recreates with the plan hash, then says Start is next', async () => {
    setup(status({ plan: plan({ reason: 'image' }) }))
    render(<SandboxActions slug="ws" />)

    await userEvent.click(button('Recreate sandbox'))
    expect(api.recreate).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Recreate the sandbox?')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Recreate' }))
    expect(api.recreate).toHaveBeenCalledExactlyOnceWith('ws', false, HASH)
    expect(await screen.findByRole('status')).toHaveTextContent(RECREATED_COPY)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('cancelling the dialog changes nothing', async () => {
    setup(status({ plan: plan() }))
    render(<SandboxActions slug="ws" />)
    await userEvent.click(button('Recreate sandbox'))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.recreate).not.toHaveBeenCalled()
  })

  it('with only recreatePending, asks main for the plan (a probe that changes nothing), then opens the dialog with it', async () => {
    setup(status({ pending: true }))
    api.recreate.mockResolvedValueOnce(ok({ ok: false, code: 'PLAN_CHANGED' }))
    // The mount refresh still knows no plan; the plan appears only after the probe.
    api.getStatus.mockResolvedValueOnce(ok(status({ pending: true })))
    api.getStatus.mockResolvedValue(ok(status({ pending: true, plan: plan({ specHash: 'b'.repeat(64) }) })))
    render(<SandboxActions slug="ws" />)
    await vi.waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(1))

    await userEvent.click(button('Recreate sandbox'))

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(api.recreate).toHaveBeenCalledTimes(1)
    expect(api.recreate).toHaveBeenCalledWith('ws', false, '0'.repeat(64))

    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Recreate' }))
    expect(api.recreate).toHaveBeenLastCalledWith('ws', false, 'b'.repeat(64))
  })

  it('with recreatePending but no plan to show, says it is unavailable instead of opening an empty dialog', async () => {
    setup(status({ pending: true }))
    api.recreate.mockResolvedValueOnce(ok({ ok: false, code: 'FAILED' }))
    api.getStatus.mockResolvedValue(ok(status({ pending: true })))
    render(<SandboxActions slug="ws" />)

    await userEvent.click(button('Recreate sandbox'))

    expect(await screen.findByRole('alert')).toHaveTextContent(SANDBOX_UNAVAILABLE_COPY)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('after a PORT_CONFLICT it recreates with a new port and clears the start error', async () => {
    setup(status({ plan: plan({ reason: 'port' }) }))
    useTerminalStore.setState({ spawnFailure: { ws: 'PORT_CONFLICT' }, spawnError: { ws: 'Another program is using the port' } })
    render(<SandboxActions slug="ws" />)

    await userEvent.click(button('Recreate sandbox'))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Recreate' }))

    expect(api.recreate).toHaveBeenCalledWith('ws', true, HASH)
    await vi.waitFor(() => expect(useTerminalStore.getState().spawnError.ws).toBeNull())
  })

  it('is aria-disabled with a reason while a session is running', async () => {
    setup(status({ state: 'running', plan: plan() }))
    render(<SandboxActions slug="ws" />)

    const recreate = button('Recreate sandbox')
    expect(recreate).toHaveAttribute('aria-disabled', 'true')
    fireEvent.focus(recreate)
    expect(screen.getByRole('tooltip')).toHaveTextContent('End the sandbox session first.')
    await userEvent.click(recreate)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('everything is disabled with a reason while the sandbox is ending', () => {
  it.each(['Hand off branch', 'Recreate sandbox', 'Delete sandbox'])('%s', async (name) => {
    setup(status({ state: 'ending', plan: plan() }))
    // Delete is hidden during a session; the other two are shown and disabled. Check Delete separately below.
    render(<SandboxActions slug="ws" />)
    const target = screen.queryByRole('button', { name })
    if (name === 'Delete sandbox') {
      expect(target).toBeNull()
      return
    }
    expect(target).toHaveAttribute('aria-disabled', 'true')
    expect(target).not.toBeDisabled()
    fireEvent.focus(target!)
    expect(screen.getByRole('tooltip')).toHaveTextContent(STILL_STOPPING)
    await userEvent.click(target!)
    expect(api.handOff).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('realm skin', () => {
  it('renders the same actions and copy', async () => {
    setup(status({ pending: true, plan: plan() }))
    render(<SandboxActions slug="ws" skin="realm" />)
    expect(button('Hand off branch')).toBeInTheDocument()
    expect(button('Recreate sandbox')).toBeInTheDocument()
    expect(button('Delete sandbox')).toBeInTheDocument()

    api.previewDelete.mockResolvedValue(ok({ sessionRunning: false, dirtyCount: 2, unmergedBranches: ['feat/a'] }))
    await userEvent.click(button('Delete sandbox'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('2 uncommitted changes will be lost.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    api.handOff.mockResolvedValueOnce(ok({ ok: false, code: 'DIRTY', dirtyCount: 2 }))
    await userEvent.click(button('Hand off branch'))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Hand off anyway?')
  })
})
