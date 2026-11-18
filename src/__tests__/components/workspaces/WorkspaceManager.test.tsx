import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { WorkspaceManager } from '../../../renderer/components/workspaces/WorkspaceManager'
import { useDiscoveryStore } from '../../../renderer/stores/discovery-store'
import { useSettingsStore } from '../../../renderer/stores/settings-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { expectNoAxeViolations } from '../../helpers/a11y'
import { installWorkspaceApi, type WorkspaceApiMock } from '../../helpers/workspace-api-mock'
import { makeWorkspace } from '../../helpers/workspace-fixture'

let api: WorkspaceApiMock

const api1 = makeWorkspace({ slug: 'api', path: '/home/amer/projects/api', displayName: 'Api', docsRoot: '/home/amer/projects/api/docs' })
const web = makeWorkspace({ slug: 'web', path: '/home/amer/projects/web', displayName: 'Web', docsRoot: '/home/amer/projects/web/docs' })

function setWorkspaces(...list: ReturnType<typeof makeWorkspace>[]): void {
  useWorkspaceStore.setState({ workspaces: list })
}

beforeEach(() => {
  setWorkspaces(api1, web)
  useWorkspaceStore.setState({ highlightSlug: null, createWarnings: new Map(), pending: new Set(), announce: '', announceSeq: 0 })
  useSettingsStore.setState({ storeHealth: { stores: { settings: 'ok', workspaces: 'ok', sandbox: 'absent', sessionDefaults: 'absent' }, configDirMismatch: false, legacyConfigPresent: false }, storeHealthDismissed: false })
  useDiscoveryStore.setState({ lastFinishedAt: null })
  api = installWorkspaceApi(() => useWorkspaceStore.getState().workspaces)
})
afterEach(() => {
  vi.useRealTimers()
})

async function expand(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }))
}

describe('rows', () => {
  it('shows the name and the home-relative path, and the heading count', () => {
    render(<WorkspaceManager skin="office" />)
    expect(screen.getByText('Workspaces (2)')).toBeInTheDocument()
    const row = screen.getByTestId('workspace-row-api')
    expect(within(row).getByText('Api')).toBeInTheDocument()
    expect(within(row).getByText('~/projects/api')).toBeInTheDocument()
  })

  it('never renders the source or the id', () => {
    setWorkspaces(makeWorkspace({ slug: 'api-2', path: '/home/amer/projects/api', displayName: 'Api', source: 'discovered' }))
    render(<WorkspaceManager skin="office" />)
    expect(screen.queryByText(/discovered/i)).toBeNull()
    expect(screen.queryByText('api-2')).toBeNull()
  })

  it('shows an availability badge for a non-ok workspace, and none for an ok one', () => {
    setWorkspaces(api1, makeWorkspace({ slug: 'web', path: '/home/amer/projects/web', displayName: 'Web', availability: 'missing' }))
    render(<WorkspaceManager skin="office" />)
    expect(within(screen.getByTestId('workspace-row-web')).getByText('Missing')).toBeInTheDocument()
    expect(within(screen.getByTestId('workspace-row-api')).queryByText('Missing')).toBeNull()
  })

  it('shows a Hidden badge in the office skin only', () => {
    setWorkspaces(makeWorkspace({ slug: 'api', path: '/home/amer/projects/api', displayName: 'Api', hidden: true }))
    const { unmount } = render(<WorkspaceManager skin="office" />)
    expect(screen.getByText('Hidden')).toBeInTheDocument()
    unmount()
    render(<WorkspaceManager skin="realm" />)
    expect(screen.queryByText('Hidden')).toBeNull()
  })

  it('says so when there are no workspaces', () => {
    setWorkspaces()
    render(<WorkspaceManager skin="office" />)
    expect(screen.getByText('No workspaces yet.')).toBeInTheDocument()
  })

  it('marks the highlighted row', () => {
    useWorkspaceStore.setState({ highlightSlug: 'web' })
    render(<WorkspaceManager skin="office" />)
    expect(screen.getByTestId('workspace-row-web')).toHaveAttribute('data-highlighted', 'true')
    expect(screen.getByTestId('workspace-row-api')).not.toHaveAttribute('data-highlighted')
  })

  it('scrolls a highlighted row into view', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    useWorkspaceStore.setState({ highlightSlug: 'web' })
    render(<WorkspaceManager skin="office" />)
    expect(scrollIntoView).toHaveBeenCalled()
    // @ts-expect-error restoring the jsdom default (the property is absent there)
    delete Element.prototype.scrollIntoView
  })

  it('shows the create warning on the row, and Dismiss removes it', () => {
    useWorkspaceStore.setState({ createWarnings: new Map([['api', ['git-unavailable' as const]]]) })
    render(<WorkspaceManager skin="office" />)
    const row = screen.getByTestId('workspace-row-api')
    expect(within(row).getByText("Created. Git wasn't found, so the folder isn't a git repository yet.")).toBeInTheDocument()
    expect(within(screen.getByTestId('workspace-row-web')).queryByText(/Created/)).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: /Dismiss/ }))
    expect(within(row).queryByText(/Created/)).toBeNull()
  })

  it('shows the store-health notice at the top in both skins', () => {
    useSettingsStore.setState({ storeHealth: { stores: { settings: 'ok', workspaces: 'recovered-partial', sandbox: 'absent', sessionDefaults: 'absent' }, configDirMismatch: false, legacyConfigPresent: false } })
    for (const skin of ['office', 'realm'] as const) {
      const { unmount } = render(<WorkspaceManager skin={skin} />)
      expect(screen.getByTestId('store-health-notice')).toBeInTheDocument()
      unmount()
    }
  })
})

describe('toolbar', () => {
  it('Discover appears only when a handler is given, and calls it', () => {
    const { unmount } = render(<WorkspaceManager skin="office" />)
    expect(screen.queryByRole('button', { name: 'Discover…' })).toBeNull()
    unmount()
    const onDiscover = vi.fn()
    render(<WorkspaceManager skin="office" onDiscover={onDiscover} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discover…' }))
    expect(onDiscover).toHaveBeenCalled()
  })

  it('shows the last scan line with Review once a scan has finished', () => {
    useDiscoveryStore.setState({ lastFinishedAt: Date.now() - 5 * 60_000 })
    const onReview = vi.fn()
    render(<WorkspaceManager skin="office" onReviewLastScan={onReview} />)
    expect(screen.getByText(/Last scan/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onReview).toHaveBeenCalled()
  })

  it('no last scan line before any scan', () => {
    render(<WorkspaceManager skin="office" />)
    expect(screen.queryByText(/Last scan/)).toBeNull()
  })

  it('Add folder… picks, adds, and reports the new workspace', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/projects/new' }, error: null })
    const onAdded = vi.fn()
    render(<WorkspaceManager skin="office" onAdded={onAdded} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('/home/amer/projects/new'))
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1))
  })

  it('New workspace… opens the create dialog', () => {
    render(<WorkspaceManager skin="office" />)
    fireEvent.click(screen.getByRole('button', { name: 'New workspace…' }))
    expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeInTheDocument()
  })
})

describe('inline edits: display name', () => {
  async function typeName(value: string): Promise<HTMLInputElement> {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    const input = screen.getByLabelText('Display name') as HTMLInputElement
    fireEvent.change(input, { target: { value } })
    return input
  }

  it('blur saves the trimmed name, then shows Saved', async () => {
    const input = await typeName('  Backend  ')
    fireEvent.blur(input)
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('api', 'Backend'))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('Enter saves, and the blur that follows does not save twice', async () => {
    const input = await typeName('Backend')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    await waitFor(() => expect(api.rename).toHaveBeenCalledTimes(1))
  })

  it('an unchanged value saves nothing', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    fireEvent.blur(screen.getByLabelText('Display name'))
    expect(api.rename).not.toHaveBeenCalled()
  })

  it('Esc reverts, and the blur that follows does not save (UX M-7)', async () => {
    const input = await typeName('Something else')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('Api')
    fireEvent.blur(input)
    expect(api.rename).not.toHaveBeenCalled()
  })

  it('after an Esc, typing again and blurring saves normally', async () => {
    const input = await typeName('Draft')
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.change(input, { target: { value: 'Final' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('api', 'Final'))
  })

  it("an empty name reverts with \"Name can't be empty\" and saves nothing", async () => {
    const input = await typeName('   ')
    fireEvent.blur(input)
    expect(await screen.findByRole('alert')).toHaveTextContent("Name can't be empty")
    expect(input.value).toBe('Api')
    expect(api.rename).not.toHaveBeenCalled()
  })

  it('a failure shows fixed copy (never the thrown message) and stays until the next edit', async () => {
    api.fail('rename', 'CONFIG_WRITE_FAILED')
    const input = await typeName('Backend')
    fireEvent.blur(input)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't save to the settings folder")
    expect(screen.queryByText(/secret/)).toBeNull()
    expect(screen.queryByText('Saved')).toBeNull()
    fireEvent.change(input, { target: { value: 'Backend 2' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a rejected name says what a name accepts', async () => {
    api.fail('rename', 'VALIDATION_ERROR')
    const input = await typeName('a/b')
    fireEvent.blur(input)
    expect(await screen.findByRole('alert')).toHaveTextContent('Use up to 64 characters, without slashes or control characters.')
  })

  it('the field keeps what the user typed after a failed save, so they can retry', async () => {
    api.fail('rename', 'CONFIG_WRITE_FAILED')
    const input = await typeName('Backend')
    fireEvent.blur(input)
    await screen.findByRole('alert')
    expect(input.value).toBe('Backend')
  })
})

describe('realm: Esc on an unsaved edit', () => {
  function Wrapped({ skin }: { skin: 'office' | 'realm' }): React.ReactElement {
    return (
      <div onKeyDown={onChamberKey} data-testid="chamber">
        <WorkspaceManager skin={skin} />
      </div>
    )
  }
  const onChamberKey = vi.fn()
  beforeEach(() => onChamberKey.mockClear())

  it('stops the event, so the Settings chamber stays open', async () => {
    render(<Wrapped skin="realm" />)
    await expand('Api')
    const input = screen.getByLabelText('Display name')
    fireEvent.change(input, { target: { value: 'Draft' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onChamberKey).not.toHaveBeenCalled()
  })

  it('lets Esc through when there is nothing to revert', async () => {
    render(<Wrapped skin="realm" />)
    await expand('Api')
    fireEvent.keyDown(screen.getByLabelText('Display name'), { key: 'Escape' })
    expect(onChamberKey).toHaveBeenCalled()
  })

  it('the office skin does not stop it', async () => {
    render(<Wrapped skin="office" />)
    await expand('Api')
    const input = screen.getByLabelText('Display name')
    fireEvent.change(input, { target: { value: 'Draft' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onChamberKey).toHaveBeenCalled()
  })
})

describe('docs root', () => {
  it('shows the effective docs root and saves an edit on blur', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    const input = screen.getByLabelText('Docs root') as HTMLInputElement
    expect(input.value).toBe('/home/amer/projects/api/docs')
    fireEvent.change(input, { target: { value: '/home/amer/notes' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.setDocsRoot).toHaveBeenCalledWith('api', '/home/amer/notes'))
  })

  it('a rejected docs root says to enter a full path or Browse', async () => {
    api.fail('setDocsRoot', 'VALIDATION_ERROR')
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    const input = screen.getByLabelText('Docs root') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.blur(input)
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a full path starting with /, or use Browse…')
  })

  it('the placeholder shows the default <path>/docs', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    expect(screen.getByLabelText('Docs root')).toHaveAttribute('placeholder', expect.stringMatching(/\/projects\/api\/docs$/))
  })

  it('clearing the field resets it to the default (null)', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    const input = screen.getByLabelText('Docs root')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    await waitFor(() => expect(api.setDocsRoot).toHaveBeenCalledWith('api', null))
  })

  it('Browse… picks a folder with the docs-root purpose and saves it', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/shared-docs' }, error: null })
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalledWith('docs-root'))
    await waitFor(() => expect(api.setDocsRoot).toHaveBeenCalledWith('api', '/home/amer/shared-docs'))
  })

  it('cancelling Browse… changes nothing', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalled())
    expect(api.setDocsRoot).not.toHaveBeenCalled()
  })

  it('a refused folder shows its fixed copy', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/.claude' }, error: null })
    api.fail('setDocsRoot', 'WORKSPACE_APP_FOLDER')
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(await screen.findByText('That folder holds Corner Office or Claude data. Pick a project folder.')).toBeInTheDocument()
  })

  it('a failed picker shows fixed copy', async () => {
    api.fail('pickFolder', 'NOT_READY')
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(await screen.findByText('Corner Office is still starting. Try again in a moment.')).toBeInTheDocument()
  })

  it('Reset to default sends null', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    await waitFor(() => expect(api.setDocsRoot).toHaveBeenCalledWith('api', null))
  })
})

describe('hide', () => {
  it('the office skin has a Hide switch with its help text, and it sends the intent', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    expect(screen.getByText('Hidden workspaces still show in the Realm.')).toBeInTheDocument()
    // A stable name: the state is aria-checked, not a name that flips.
    expect(screen.getByRole('switch', { name: 'Hide this workspace' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(api.setHidden).toHaveBeenCalledWith('api', true))
  })

  it('a hidden workspace offers Show', async () => {
    setWorkspaces(makeWorkspace({ slug: 'api', path: '/home/amer/projects/api', displayName: 'Api', hidden: true }))
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    expect(screen.getByRole('switch', { name: 'Hide this workspace' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(api.setHidden).toHaveBeenCalledWith('api', false))
  })

  it('a failure shows fixed copy', async () => {
    api.fail('setHidden', 'CONFIG_WRITE_FAILED')
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText(/Couldn't save to/)).toBeInTheDocument()
  })

  it('the realm skin has no hide control at all', async () => {
    render(<WorkspaceManager skin="realm" />)
    await expand('Api')
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText(/Hidden workspaces still show/)).toBeNull()
  })
})

describe('remove', () => {
  async function openRemove(): Promise<void> {
    await expand('Api')
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Corner Office…' }))
  }

  it('asks first, and says no files are deleted', async () => {
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('This only removes Api from the list. No files are deleted.')).toBeInTheDocument()
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('for an unavailable workspace the dialog explains what re-adding resets', async () => {
    setWorkspaces(makeWorkspace({ slug: 'api', path: '/home/amer/projects/api', displayName: 'Api', availability: 'missing' }), web)
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('If you moved it, remove it and add the new location. Its name, docs-root setting and sandbox allowlist will be reset.')).toBeInTheDocument()
  })

  it('an available workspace gets no moved-folder note', async () => {
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).queryByText(/If you moved it/)).toBeNull()
  })

  it('confirming removes it and reports the slug', async () => {
    const onRemoved = vi.fn()
    render(<WorkspaceManager skin="office" onRemoved={onRemoved} />)
    await openRemove()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('api'))
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('api'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('after a removal, focus lands on the Workspaces heading, not the page (UX M-5)', async () => {
    render(<WorkspaceManager skin="office" />)
    await expand('Api')
    const opener = screen.getByRole('button', { name: 'Remove from Corner Office…' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalled())
    // The store drops the row, as main's listChanged would.
    act(() => setWorkspaces(web))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /Workspaces \(/ }))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('a double click on Remove sends one removal', async () => {
    let release: () => void = () => undefined
    api.remove.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { removed: true }, error: null })
        }),
    )
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    const confirmButton = await screen.findByRole('button', { name: 'Remove' })
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)
    expect(api.remove).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('Cancel removes nothing', async () => {
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(api.remove).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('mentions a sandbox worktree that stays on disk', async () => {
    api.getStatus.mockResolvedValue({ data: { worktree: 'ready' }, error: null })
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    expect(await screen.findByText(/Its sandbox worktree at/)).toHaveTextContent('~/.corner-office/sandboxes/api stays on disk. Delete it yourself if you no longer need it.')
  })

  it.each([
    ['no worktree', { data: { worktree: 'absent' }, error: null }],
    ['sandboxes off in this profile', { data: null, error: { code: 'SANDBOX_OFF_IN_PROFILE', message: 'x' } }],
  ])('says nothing about a worktree for %s', async (_name, response) => {
    api.getStatus.mockResolvedValue(response)
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    await screen.findByRole('alertdialog')
    await waitFor(() => expect(api.getStatus).toHaveBeenCalled())
    expect(screen.queryByText(/sandbox worktree/)).toBeNull()
  })

  it('a status call that throws still lets you remove', async () => {
    api.getStatus.mockRejectedValue(new Error('boom'))
    render(<WorkspaceManager skin="office" />)
    await openRemove()
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.queryByText(/sandbox worktree/)).toBeNull()
  })

  it.each([
    ['WORKSPACE_BUSY_TERMINAL', 'A session is running in this workspace. End it first.'],
    ['WORKSPACE_BUSY_SANDBOX', 'Its sandbox is running. End the sandbox session first.'],
  ])('%s keeps the dialog open with its copy', async (code, copy) => {
    api.fail('remove', code)
    const onRemoved = vi.fn()
    render(<WorkspaceManager skin="office" onRemoved={onRemoved} />)
    await openRemove()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(copy)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('works in the realm skin too', async () => {
    render(<WorkspaceManager skin="realm" />)
    await openRemove()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('api'))
  })
})

describe('accessibility', () => {
  it('has no axe violations, collapsed or expanded, in either skin', async () => {
    for (const skin of ['office', 'realm'] as const) {
      const { container, unmount } = render(<WorkspaceManager skin={skin} onDiscover={() => undefined} />)
      await expectNoAxeViolations(container)
      await act(async () => {
        await expand('Api')
      })
      await expectNoAxeViolations(container)
      unmount()
    }
  })
})
