import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LegacyNotice } from '../../../renderer/components/workspaces/LegacyNotice'
import { useSettingsStore } from '../../../renderer/stores/settings-store'
import type { StoreHealthView } from '../../../renderer/stores/settings-store'
import { expectNoAxeViolations } from '../../helpers/a11y'

const getStoreHealth = vi.fn()
const update = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: { config: { getStoreHealth: () => getStoreHealth(), update: (body: unknown) => update(body) } },
  writable: true,
  configurable: true,
})

const health = (legacyConfigPresent: boolean): StoreHealthView => ({
  stores: { settings: 'ok', workspaces: 'ok', sandbox: 'ok', sessionDefaults: 'ok' },
  configDirMismatch: false,
  legacyConfigPresent,
})

const settings = (legacyNoticeDismissed: boolean) => ({ companyName: '', legacyNoticeDismissed }) as never

function setState(storeHealth: StoreHealthView | null, config: unknown): void {
  act(() => useSettingsStore.setState({ storeHealth, config: config as never }))
}

beforeEach(() => {
  getStoreHealth.mockReset()
  update.mockReset()
  getStoreHealth.mockResolvedValue({ data: health(true), error: null })
})
afterEach(() => setState(null, null))

describe('LegacyNotice', () => {
  it('shows the upgrade copy while the old config is present and not dismissed', () => {
    setState(health(true), settings(false))
    render(<LegacyNotice skin="office" />)
    expect(
      screen.getByText(
        "Your earlier workspace list and sandbox settings weren't carried over. Run Discover to find your projects. Sandbox network allowlists, ports and extra packages were reset to safe defaults. Only add back what you still need, in the Armory.",
      ),
    ).toBeInTheDocument()
  })

  it('shows it whatever the registry holds (not only when it is empty)', () => {
    setState(health(true), settings(false))
    render(<LegacyNotice skin="realm" />)
    expect(screen.getByTestId('legacy-notice')).toBeInTheDocument()
  })

  it('renders nothing without a legacy config, once dismissed, or before settings load', () => {
    setState(health(false), settings(false))
    const a = render(<LegacyNotice skin="office" />)
    expect(a.container).toBeEmptyDOMElement()
    a.unmount()

    setState(health(true), settings(true))
    const b = render(<LegacyNotice skin="office" />)
    expect(b.container).toBeEmptyDOMElement()
    b.unmount()

    setState(health(true), null)
    const c = render(<LegacyNotice skin="office" />)
    expect(c.container).toBeEmptyDOMElement()
  })

  it('fetches the store health once when it is not loaded yet', async () => {
    setState(null, settings(false))
    render(<LegacyNotice skin="office" />)
    expect(getStoreHealth).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('legacy-notice')).toBeInTheDocument()
  })

  it('survives a failed health fetch', async () => {
    setState(null, settings(false))
    getStoreHealth.mockRejectedValue(new Error('nope'))
    const { container } = render(<LegacyNotice skin="office" />)
    await waitFor(() => expect(getStoreHealth).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('Dismiss saves legacyNoticeDismissed to settings and the notice stays gone', async () => {
    update.mockResolvedValue({ data: settings(true), error: null })
    setState(health(true), settings(false))
    const { container } = render(<LegacyNotice skin="office" />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(update).toHaveBeenCalledWith({ legacyNoticeDismissed: true })
    expect(useSettingsStore.getState().config?.legacyNoticeDismissed).toBe(true)
  })

  it('a failed save keeps the notice and shows fixed copy, never the thrown message', async () => {
    update.mockResolvedValue({ data: null, error: { code: 'CONFIG_WRITE_FAILED', message: '/secret/path raw' } })
    setState(health(true), settings(false))
    render(<LegacyNotice skin="office" />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save to the settings folder.")
    expect(screen.queryByText(/secret/)).toBeNull()
    expect(screen.getByTestId('legacy-notice')).toBeInTheDocument()
  })

  it.each(['office', 'realm'] as const)('has no axe violations (%s)', async (skin) => {
    setState(health(true), settings(false))
    const { container } = render(<LegacyNotice skin={skin} />)
    await expectNoAxeViolations(container)
  })
})
