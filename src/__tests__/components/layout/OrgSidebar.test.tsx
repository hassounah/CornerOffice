import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import type { Workspace } from '@main/types/workspace'
import { defaultSettings } from '@main/services/stores'
import { OrgSidebar } from '../../../renderer/components/layout/OrgSidebar'
import { useSettingsStore } from '../../../renderer/stores/settings-store'
import { useSidebarStore } from '../../../renderer/stores/sidebar-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { expectNoAxeViolations } from '../../helpers/a11y'
import { installWorkspaceApi, type WorkspaceApiMock } from '../../helpers/workspace-api-mock'
import { makeWorkspace } from '../../helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// OrgSidebar (#0039 4.5, TRD §4.4/§4.5): the real workspace and sidebar stores.
// ---------------------------------------------------------------------------

const originals = {
  workspace: useWorkspaceStore.getState(),
  settings: useSettingsStore.getState(),
  sidebar: useSidebarStore.getState(),
}

let registry: Workspace[] = []
let api: WorkspaceApiMock

const ws = (slug: string, overrides: Partial<Workspace> = {}): Workspace =>
  makeWorkspace({ slug, path: `/home/test/${slug}`, displayName: `WS ${slug}`, ...overrides })

function renderSidebar(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<OrgSidebar />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** The row button of a workspace (not its "…" or Show button): the one titled with its path. */
const rowTitle = (name: string): string => `/home/test/${name.replace(/^WS /, '')}`
const row = (name: string): HTMLElement => screen.getByTitle(rowTitle(name))
const queryRow = (name: string): HTMLElement | null => screen.queryByTitle(rowTitle(name))

function setRegistry(next: Workspace[]): void {
  registry = next
  useWorkspaceStore.setState({ workspaces: next })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api = installWorkspaceApi(() => registry)
  registry = []
  useWorkspaceStore.setState({ ...originals.workspace, workspaces: [], selectedSlug: null, pending: new Set() })
  useSettingsStore.setState({ ...originals.settings, config: null })
  useSidebarStore.setState({ ...originals.sidebar, hiddenExpanded: false, focusSeq: 0 })
})

afterEach(() => {
  useWorkspaceStore.setState(originals.workspace)
  useSettingsStore.setState(originals.settings)
  useSidebarStore.setState(originals.sidebar)
})

describe('header and navigation', () => {
  it('shows the "Corner Office" fallback when there is no company name', () => {
    renderSidebar()
    expect(screen.getByText('Corner Office')).toBeInTheDocument()
  })

  it('shows the company name from the settings', () => {
    useSettingsStore.setState({ config: { ...defaultSettings(), companyName: 'Acme Corp' } })
    renderSidebar()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })

  it('renders all nav items and marks the current one', () => {
    renderSidebar('/')
    for (const label of ['Dashboard', 'Homunculus', 'Notifications', 'Settings']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Dashboard/ })).toHaveAttribute('aria-current', 'page')
  })

  it('says there are no workspaces yet when the registry is empty', () => {
    renderSidebar()
    expect(screen.getByText('No workspaces yet.')).toBeInTheDocument()
  })
})

describe('the workspace list', () => {
  it('has no Pinned or Archived section any more', () => {
    setRegistry([ws('a')])
    renderSidebar()
    expect(screen.queryByText('Pinned')).toBeNull()
    expect(screen.queryByRole('button', { name: /Archived/ })).toBeNull()
  })

  it('selecting a row selects the workspace', () => {
    setRegistry([ws('a')])
    renderSidebar()
    fireEvent.click(row('WS a'))
    expect(useWorkspaceStore.getState().selectedSlug).toBe('a')
  })

  it('shows a badge on a workspace that is not usable, and still opens it', () => {
    setRegistry([ws('gone', { availability: 'missing' }), ws('ok')])
    renderSidebar()
    const gone = row('WS gone')
    expect(within(gone).getByText('Missing')).toBeInTheDocument()
    expect(within(row('WS ok')).queryByText('Missing')).toBeNull()
    fireEvent.click(gone)
    expect(useWorkspaceStore.getState().selectedSlug).toBe('gone')
  })

  it('leaves hidden workspaces out of the main list', () => {
    setRegistry([ws('a'), ws('b', { hidden: true })])
    renderSidebar()
    expect(row('WS a')).toBeInTheDocument()
    expect(queryRow('WS b')).toBeNull()
  })

  it('arrow keys move between the listed workspaces', () => {
    setRegistry([ws('a', { lastActivityTimestamp: '2025-02-01T00:00:00Z' }), ws('b', { lastActivityTimestamp: '2025-01-01T00:00:00Z' })])
    useWorkspaceStore.setState({ selectedSlug: 'a' })
    renderSidebar()
    fireEvent.keyDown(row('WS a'), { key: 'ArrowDown' })
    expect(useWorkspaceStore.getState().selectedSlug).toBe('b')
  })
})

describe('the "…" menu and Hide', () => {
  it('each row has an actions button, shown on hover and focus-within', () => {
    setRegistry([ws('a')])
    renderSidebar()
    const actions = screen.getByRole('button', { name: 'Actions for WS a' })
    expect(actions).toHaveAttribute('aria-haspopup', 'menu')
    expect(actions).toHaveAttribute('aria-expanded', 'false')
    expect(actions.className).toContain('group-hover:opacity-100')
    expect(actions.className).toContain('group-focus-within:opacity-100')
  })

  it('opens a menu with Hide, focuses it, and Escape closes it back onto the button', () => {
    setRegistry([ws('a')])
    renderSidebar()
    const actions = screen.getByRole('button', { name: 'Actions for WS a' })
    fireEvent.click(actions)
    expect(actions).toHaveAttribute('aria-expanded', 'true')
    const hide = screen.getByRole('menuitem', { name: 'Hide' })
    expect(hide).toHaveFocus()
    fireEvent.keyDown(hide, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(actions).toHaveFocus()
  })

  it('a click elsewhere closes the menu', () => {
    setRegistry([ws('a')])
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for WS a' }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('arrow keys inside the menu do not move the selection', () => {
    setRegistry([ws('a'), ws('b')])
    useWorkspaceStore.setState({ selectedSlug: 'a' })
    renderSidebar()
    fireEvent.click(screen.getAllByRole('button', { name: /^Actions for/ })[0])
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Hide' }), { key: 'ArrowDown' })
    expect(useWorkspaceStore.getState().selectedSlug).toBe('a')
  })

  it('Hide sends the intent, moves the item to Hidden (N), and focus goes to the next item', async () => {
    setRegistry([ws('a', { lastActivityTimestamp: '2025-03-01T00:00:00Z' }), ws('b', { lastActivityTimestamp: '2025-02-01T00:00:00Z' }), ws('c', { lastActivityTimestamp: '2025-01-01T00:00:00Z' })])
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for WS a' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(api.setHidden).toHaveBeenCalledWith('a', true))
    await waitFor(() => expect(row('WS b')).toHaveFocus())
    expect(queryRow('WS a')).toBeNull()
    expect(screen.getByRole('button', { name: /Hidden \(1\)/ })).toBeInTheDocument()
  })

  it('hiding the last listed item focuses the previous one', async () => {
    setRegistry([ws('a', { lastActivityTimestamp: '2025-02-01T00:00:00Z' }), ws('b', { lastActivityTimestamp: '2025-01-01T00:00:00Z' })])
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for WS b' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(row('WS a')).toHaveFocus())
  })

  it('hiding the only item focuses the Hidden header', async () => {
    setRegistry([ws('a')])
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for WS a' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Hidden \(1\)/ })).toHaveFocus())
  })

  it('a failed Hide leaves the item and puts focus back on it', async () => {
    api.fail('setHidden', 'NOT_FOUND')
    setRegistry([ws('a'), ws('b')])
    renderSidebar()
    fireEvent.click(screen.getAllByRole('button', { name: /^Actions for/ })[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(api.setHidden).toHaveBeenCalled())
    await waitFor(() => expect(document.activeElement).toBe(row('WS a')))
    expect(screen.queryByRole('button', { name: /Hidden \(/ })).toBeNull()
  })
})

describe('the Hidden (N) section', () => {
  it('is not rendered at N = 0', () => {
    setRegistry([ws('a')])
    renderSidebar()
    expect(screen.queryByRole('button', { name: /Hidden \(/ })).toBeNull()
  })

  it('is collapsed by default, with a header that counts', () => {
    setRegistry([ws('a'), ws('b', { hidden: true }), ws('c', { hidden: true })])
    renderSidebar()
    const header = screen.getByRole('button', { name: /Hidden \(2\)/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Show WS b' })).toBeNull()
  })

  it('expands on click and remembers it in localStorage', () => {
    setRegistry([ws('a'), ws('b', { hidden: true })])
    const { unmount } = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Hidden \(1\)/ }))
    expect(screen.getByRole('button', { name: 'Show WS b' })).toBeInTheDocument()
    expect(window.localStorage.getItem('co.sidebar.hiddenExpanded')).toBe('true')
    unmount()
    // A fresh store reads what was saved.
    useSidebarStore.setState({ hiddenExpanded: window.localStorage.getItem('co.sidebar.hiddenExpanded') === 'true' })
    renderSidebar()
    expect(screen.getByRole('button', { name: /Hidden \(1\)/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('collapses again and remembers that', () => {
    setRegistry([ws('a'), ws('b', { hidden: true })])
    useSidebarStore.setState({ hiddenExpanded: true })
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: /Hidden \(1\)/ }))
    expect(screen.queryByRole('button', { name: 'Show WS b' })).toBeNull()
    expect(window.localStorage.getItem('co.sidebar.hiddenExpanded')).toBe('false')
  })

  it('Show moves the workspace back to the list and focuses it', async () => {
    setRegistry([ws('a'), ws('b', { hidden: true })])
    useSidebarStore.setState({ hiddenExpanded: true })
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Show WS b' }))
    await waitFor(() => expect(api.setHidden).toHaveBeenCalledWith('b', false))
    await waitFor(() => expect(row('WS b')).toHaveFocus())
    expect(screen.queryByRole('button', { name: /Hidden \(/ })).toBeNull()
  })

  it('a failed Show leaves the item hidden', async () => {
    api.fail('setHidden', 'NOT_FOUND')
    setRegistry([ws('a'), ws('b', { hidden: true })])
    useSidebarStore.setState({ hiddenExpanded: true })
    renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Show WS b' }))
    await waitFor(() => expect(api.setHidden).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Show WS b' })).toBeInTheDocument()
  })

  it('a hidden workspace is still reachable: its row opens it', () => {
    setRegistry([ws('a'), ws('b', { hidden: true })])
    useSidebarStore.setState({ hiddenExpanded: true })
    renderSidebar()
    fireEvent.click(row('WS b'))
    expect(useWorkspaceStore.getState().selectedSlug).toBe('b')
  })

  it('shows an attention dot and count on the header when a hidden workspace needs attention', () => {
    setRegistry([ws('a'), ws('b', { hidden: true, status: 'attention' }), ws('c', { hidden: true })])
    renderSidebar()
    const header = screen.getByRole('button', { name: /Hidden \(2\)/ })
    expect(header).toHaveAccessibleName(/1 needs attention/)
    expect(header.querySelector('.bg-co-status-attention')).not.toBeNull()
  })

  it('has no attention dot when no hidden workspace needs attention', () => {
    setRegistry([ws('a'), ws('b', { hidden: true })])
    renderSidebar()
    const header = screen.getByRole('button', { name: /Hidden \(1\)/ })
    expect(header).not.toHaveAccessibleName(/attention/)
    expect(header.querySelector('.bg-co-status-attention')).toBeNull()
  })

  it('counts several hidden workspaces that need attention', () => {
    setRegistry([ws('a'), ws('b', { hidden: true, status: 'attention' }), ws('c', { hidden: true, status: 'attention' })])
    renderSidebar()
    expect(screen.getByRole('button', { name: /Hidden \(2\)/ })).toHaveAccessibleName(/2 need attention/)
  })

  it('the Dashboard footer request expands the section and focuses its header', async () => {
    setRegistry([ws('a'), ws('b', { hidden: true })])
    renderSidebar()
    expect(screen.getByRole('button', { name: /Hidden \(1\)/ })).toHaveAttribute('aria-expanded', 'false')
    act(() => useSidebarStore.getState().requestShowHidden())
    const header = screen.getByRole('button', { name: /Hidden \(1\)/ })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(header).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Show WS b' })).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('has no axe violations with a hidden section, a badge and a menu open', async () => {
    setRegistry([ws('a'), ws('gone', { availability: 'missing' }), ws('h', { hidden: true, status: 'attention' })])
    useSidebarStore.setState({ hiddenExpanded: true })
    const { container } = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for WS a' }))
    await expectNoAxeViolations(container)
  })
})
