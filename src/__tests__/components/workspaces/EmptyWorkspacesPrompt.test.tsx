import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'
import type { StoreHealth } from '../../../main/services/json-store'
import type { StoreHealthMap } from '../../../main/services/store-files'
import { EmptyWorkspacesPrompt } from '../../../renderer/components/workspaces/EmptyWorkspacesPrompt'
import { useDiscoveryStore } from '../../../renderer/stores/discovery-store'
import { useSettingsStore } from '../../../renderer/stores/settings-store'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { IpcError } from '../../../renderer/utils/ipc'
import { makeWorkspace } from '../../helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// EmptyWorkspacesPrompt (#0039 step 4.4, TRD §4.7, UX M7, M-3, H-7).
// ---------------------------------------------------------------------------

const originals = {
  discovery: useDiscoveryStore.getState(),
  workspace: useWorkspaceStore.getState(),
  settings: useSettingsStore.getState(),
}

const pickFolder = vi.fn()
const add = vi.fn()
const addMany = vi.fn()
const start = vi.fn()
const cancel = vi.fn()
const reset = vi.fn()

const health = (over: { legacyConfigPresent?: boolean; configDirMismatch?: boolean; workspaces?: StoreHealth } = {}) => ({
  stores: { settings: 'ok', workspaces: over.workspaces ?? 'ok', sandbox: 'ok', sessionDefaults: 'ok' } satisfies StoreHealthMap,
  configDirMismatch: over.configDirMismatch ?? false,
  legacyConfigPresent: over.legacyConfigPresent ?? false,
})

function setup(props: Partial<React.ComponentProps<typeof EmptyWorkspacesPrompt>> = {}) {
  const onCreate = vi.fn()
  const onOpenWorkspace = vi.fn()
  const view = render(<EmptyWorkspacesPrompt skin="office" onCreate={onCreate} onOpenWorkspace={onOpenWorkspace} {...props} />)
  return { ...view, onCreate, onOpenWorkspace }
}

beforeEach(() => {
  vi.clearAllMocks()
  useDiscoveryStore.setState({ ...originals.discovery, running: false, result: null, lastResult: null, start, cancel, reset })
  useWorkspaceStore.setState({ ...originals.workspace, workspaces: [], pending: new Set(), pickFolder, add, addMany })
  useSettingsStore.setState({ ...originals.settings, storeHealth: health(), storeHealthDismissed: false })
})

afterEach(() => {
  useDiscoveryStore.setState(originals.discovery)
  useWorkspaceStore.setState(originals.workspace)
  useSettingsStore.setState(originals.settings)
})

describe('copy', () => {
  it('office copy', () => {
    setup({ skin: 'office' })
    expect(screen.getByRole('heading', { name: 'No workspaces yet. Try Discover to look for projects, or add a folder.' })).toBeInTheDocument()
  })

  it('realm copy is distinct', () => {
    setup({ skin: 'realm' })
    expect(screen.getByRole('heading', { name: 'Your realm has no lands yet. Try Discover to look for projects, or add a folder to found the first one.' })).toBeInTheDocument()
    expect(screen.queryByText(/No workspaces yet/)).toBeNull()
  })

  it('offers the three actions, Discover first', () => {
    setup()
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual(['Discover', 'Add folder…', 'New workspace…'])
  })

  it('the realm overlay repeats the upgrade notice (the shell strip is covered); the office skin leaves it to AppShell', () => {
    act(() => useSettingsStore.setState({ storeHealth: health({ legacyConfigPresent: true }), config: { legacyNoticeDismissed: false } as never }))
    const realm = setup({ skin: 'realm' })
    expect(screen.getByText(/Your earlier workspace list and sandbox settings weren't carried over/)).toBeInTheDocument()
    realm.unmount()
    setup({ skin: 'office' })
    expect(screen.queryByText(/earlier workspace list/)).toBeNull()
  })

  it('shows the store-health notice when a store was repaired', () => {
    act(() => useSettingsStore.setState({ storeHealth: health({ workspaces: 'recovered-partial' }) }))
    setup()
    expect(screen.getByText(/Some workspaces in your list were unreadable/)).toBeInTheDocument()
  })

  it('shows no notice when every store is ok', () => {
    setup()
    expect(screen.queryByText(/was damaged|were unreadable|couldn't be read/)).toBeNull()
  })
})

describe('actions', () => {
  it('New workspace… calls onCreate', () => {
    const { onCreate } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'New workspace…' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('Add folder… picks, adds, and opens the new workspace', async () => {
    pickFolder.mockResolvedValue('/work/api')
    add.mockResolvedValue(makeWorkspace({ slug: 'api' }))
    const { onOpenWorkspace } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await act(async () => {})
    expect(pickFolder).toHaveBeenCalledWith('add')
    expect(add).toHaveBeenCalledWith('/work/api')
    expect(onOpenWorkspace).toHaveBeenCalledWith('api')
  })

  it('cancelling the folder picker does nothing', async () => {
    pickFolder.mockResolvedValue(null)
    const { onOpenWorkspace } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await act(async () => {})
    expect(add).not.toHaveBeenCalled()
    expect(onOpenWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an add failure shows the fixed copy for its code, inline', async () => {
    pickFolder.mockResolvedValue('/home/amer')
    add.mockRejectedValue(new IpcError('WORKSPACE_UNSAFE_ROOT', 'ignored'))
    const { onOpenWorkspace } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await act(async () => {})
    expect(screen.getByRole('alert')).toHaveTextContent("Corner Office can't use your home folder or a folder above it. Pick a project folder.")
    expect(onOpenWorkspace).not.toHaveBeenCalled()
  })

  it('an unexpected failure shows the UNKNOWN copy, not the message', async () => {
    pickFolder.mockRejectedValue(new Error('EACCES /home/amer/secret'))
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await act(async () => {})
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Nothing was changed.')
    expect(screen.queryByText(/secret/)).toBeNull()
  })

  it('Add folder… is disabled while a pick or add is pending', () => {
    useWorkspaceStore.setState({ pending: new Set(['add']) })
    setup()
    expect(screen.getByRole('button', { name: 'Add folder…' })).toBeDisabled()
  })
})

describe('Discover', () => {
  it('opens the dialog (which starts the scan) and focus returns to the button on close', () => {
    useDiscoveryStore.setState({ result: { status: 'complete', candidates: [], dirsScanned: 1, unreadableDirs: 0, slowDirs: 0, prunedDirs: 0, lastDir: null, elapsedMs: 1, maxDepth: 6, error: null } })
    setup()
    const opener = screen.getByRole('button', { name: 'Discover' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(start).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('opens the first workspace added from the dialog', async () => {
    addMany.mockResolvedValue({ added: [makeWorkspace({ slug: 'first' }), makeWorkspace({ slug: 'second' })], skipped: [] })
    useDiscoveryStore.setState({
      result: {
        status: 'complete',
        candidates: [
          { path: '/real/first', displayPath: '~/first', name: 'first', hasGit: false, alreadyRegistered: false, registeredId: null },
          { path: '/real/second', displayPath: '~/second', name: 'second', hasGit: false, alreadyRegistered: false, registeredId: null },
        ],
        dirsScanned: 2,
        unreadableDirs: 0,
        slowDirs: 0,
        prunedDirs: 0,
        lastDir: null,
        elapsedMs: 1,
        maxDepth: 6,
        error: null,
      },
    })
    const { onOpenWorkspace } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 workspaces' }))
    await act(async () => {})
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1)
    expect(onOpenWorkspace).toHaveBeenCalledWith('first')
  })
})

describe('in the realm overlay', () => {
  it('the dialog stacks above the overlay (top layer) and focus is trapped inside it', () => {
    useDiscoveryStore.setState({ running: true })
    render(
      <div data-testid="overlay" style={{ position: 'fixed', zIndex: 5 }}>
        <button>behind</button>
        <EmptyWorkspacesPrompt skin="realm" onCreate={vi.fn()} onOpenWorkspace={vi.fn()} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }))
    const dialog = screen.getByRole('dialog')
    // A native modal <dialog> sits in the browser top layer, above any z-index.
    expect(dialog.tagName).toBe('DIALOG')
    expect((dialog as HTMLDialogElement).open).toBe(true)
    // Tab from the last control stays inside the dialog.
    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    cancelButton.focus()
    act(() => {
      fireEvent.keyDown(cancelButton, { key: 'Tab' })
    })
    expect(dialog.contains(document.activeElement)).toBe(true)
    // Shift+Tab from the heading wraps within it too.
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: true })
    })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})

describe('accessibility', () => {
  it.each(['office', 'realm'] as const)('passes an axe check (%s)', async (skin) => {
    act(() => useSettingsStore.setState({ storeHealth: health({ legacyConfigPresent: true }), config: { legacyNoticeDismissed: false } as never }))
    const { container } = setup({ skin })
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations).toEqual([])
  })
})
