import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { StoreHealthNotice } from '../../../renderer/components/workspaces/StoreHealthNotice'
import { useSettingsStore } from '../../../renderer/stores/settings-store'
import type { StoreHealthView } from '../../../renderer/stores/settings-store'
import { expectNoAxeViolations } from '../../helpers/a11y'

const revealStoreFile = vi.fn()
const getStoreHealth = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: { config: { revealStoreFile: (store: string) => revealStoreFile(store), getStoreHealth: () => getStoreHealth() } },
  writable: true,
  configurable: true,
})

const healthy: StoreHealthView = {
  stores: { settings: 'ok', workspaces: 'ok', sandbox: 'absent', sessionDefaults: 'absent' },
  configDirMismatch: false,
  legacyConfigPresent: false,
}

function setHealth(health: StoreHealthView | null, dismissed = false): void {
  useSettingsStore.setState({ storeHealth: health, storeHealthDismissed: dismissed })
}

beforeEach(() => {
  revealStoreFile.mockReset()
  getStoreHealth.mockReset()
  getStoreHealth.mockResolvedValue({ data: healthy, error: null })
  setHealth(healthy)
})
afterEach(() => setHealth(null))

describe('StoreHealthNotice', () => {
  it('renders nothing when every store is ok or absent', () => {
    const { container } = render(<StoreHealthNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('fetches the health once when it is not loaded yet, and then renders what it finds', async () => {
    setHealth(null)
    getStoreHealth.mockResolvedValue({ data: { ...healthy, stores: { ...healthy.stores, workspaces: 'recovered-partial' } }, error: null })
    render(<StoreHealthNotice />)
    expect(getStoreHealth).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/Some workspaces in your list were unreadable/)).toBeInTheDocument()
  })

  it('survives a failed health fetch and renders nothing', async () => {
    setHealth(null)
    getStoreHealth.mockRejectedValue(new Error('nope'))
    const { container } = render(<StoreHealthNotice />)
    await waitFor(() => expect(getStoreHealth).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['recovered-from-backup', 'settings', 'Your settings were damaged, so the last backup was restored. Recent changes may be missing: check them in Settings.'],
    ['recovered-partial', 'workspaces', 'Some workspaces in your list were unreadable and were left out. Run Discover or Add folder to bring them back.'],
    ['reset-to-defaults', 'workspaces', "Your workspace list couldn't be read, so it was reset and is empty. Run Discover or Add folder to rebuild it."],
    ['reset-to-defaults', 'sandbox', "Your sandbox settings couldn't be read. Allowlists, ports and extra packages were reset to the defaults. Re-enter them in the Armory."],
    ['reset-to-defaults', 'sessionDefaults', "Your remembered session choices couldn't be read and were reset. Pick them again when you start a session."],
    ['unreadable', 'workspaces', "Your workspace list couldn't be read just now, so it may look empty. Nothing was changed. Check that the settings folder is readable; it is tried again on its own."],
  ] as const)('%s on %s shows the exact copy', (state, store, copy) => {
    setHealth({ ...healthy, stores: { ...healthy.stores, [store]: state } })
    render(<StoreHealthNotice />)
    expect(screen.getByText(copy)).toBeInTheDocument()
  })

  it('names the real .corrupt-<ts> file main kept', () => {
    setHealth({
      ...healthy,
      stores: { ...healthy.stores, workspaces: 'reset-to-defaults' },
      details: {
        settings: { health: 'ok' },
        workspaces: { health: 'reset-to-defaults', recoveredAt: 1, corruptName: 'workspaces.json.corrupt-20260101T000000Z' },
        sandbox: { health: 'absent' },
        sessionDefaults: { health: 'absent' },
      },
    })
    render(<StoreHealthNotice />)
    expect(screen.getByText(/The damaged file was kept as workspaces\.json\.corrupt-20260101T000000Z\./)).toBeInTheDocument()
  })

  it('shows one line per damaged store', () => {
    setHealth({ ...healthy, stores: { ...healthy.stores, settings: 'reset-to-defaults', workspaces: 'recovered-from-backup' } })
    render(<StoreHealthNotice />)
    expect(screen.getAllByRole('button', { name: /Reveal .* in folder/ })).toHaveLength(2)
  })

  it('shows the config-dir mismatch with the folder it was given', () => {
    setHealth({ ...healthy, configDirMismatch: true, configDirDisplay: '~/.cfg/corner-office' })
    render(<StoreHealthNotice />)
    expect(screen.getByText("Settings are saved in ~/.cfg/corner-office, which differs from Electron's data folder. Check `XDG_CONFIG_HOME`.")).toBeInTheDocument()
  })

  it('falls back to the default settings folder when main does not name one', () => {
    setHealth({ ...healthy, configDirMismatch: true })
    render(<StoreHealthNotice />)
    expect(screen.getByText(/Settings are saved in ~\/\.config\/corner-office/)).toBeInTheDocument()
  })

  it('Reveal sends the store NAME, never a path', async () => {
    revealStoreFile.mockResolvedValue({ data: { revealed: true }, error: null })
    setHealth({ ...healthy, stores: { ...healthy.stores, sessionDefaults: 'recovered-partial' } })
    render(<StoreHealthNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal session-defaults.json in folder' }))
    await waitFor(() => expect(revealStoreFile).toHaveBeenCalledWith('sessionDefaults'))
  })

  it('a failed reveal shows fixed copy, never the thrown message', async () => {
    revealStoreFile.mockResolvedValue({ data: null, error: { code: 'WORKSPACE_PATH_NOT_FOUND', message: '/secret/path raw' } })
    setHealth({ ...healthy, stores: { ...healthy.stores, settings: 'reset-to-defaults' } })
    render(<StoreHealthNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal settings.json in folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("That folder doesn't exist anymore.")
    expect(screen.queryByText(/secret/)).toBeNull()
  })

  it('Dismiss hides it for the session', () => {
    setHealth({ ...healthy, stores: { ...healthy.stores, settings: 'reset-to-defaults' } })
    const { container } = render(<StoreHealthNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useSettingsStore.getState().storeHealthDismissed).toBe(true)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays hidden when it was already dismissed', () => {
    setHealth({ ...healthy, stores: { ...healthy.stores, settings: 'reset-to-defaults' } }, true)
    const { container } = render(<StoreHealthNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('has no axe violations', async () => {
    setHealth({ ...healthy, configDirMismatch: true, stores: { ...healthy.stores, workspaces: 'recovered-partial' } })
    const { container } = render(<StoreHealthNotice />)
    await expectNoAxeViolations(container)
  })
})
