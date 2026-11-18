import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSettingsStore } from '../../renderer/stores/settings-store'
import { defaultSettings } from '../../main/services/stores'

// ---------------------------------------------------------------------------
// settings-store additions (#0039 step 4.1): the Settings type, setAssignment, setExclusions, fetchStoreHealth.
// ---------------------------------------------------------------------------

const api = {
  config: { get: vi.fn(), update: vi.fn(), getStoreHealth: vi.fn() },
  realm: { setAssignment: vi.fn() },
  discovery: { setExclusions: vi.fn() },
}
Object.defineProperty(window, 'cornerOffice', { value: api, writable: true, configurable: true })

const ok = <T,>(data: T) => ({ data, error: null })
const fail = (code: string) => ({ data: null, error: { code, message: 'fixed' } })
const state = () => useSettingsStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ config: defaultSettings(), loading: false, error: null, storeHealth: null, storeHealthDismissed: false })
})

describe('setAssignment', () => {
  it('sends the intent and takes main\'s realm back as the config', async () => {
    const realm = { ...defaultSettings().realm, mapping: [{ location: 'castle' as const, workspaceSlug: 'api' }] }
    api.realm.setAssignment.mockResolvedValue(ok(realm))
    await state().setAssignment('castle', 'api')
    expect(api.realm.setAssignment).toHaveBeenCalledWith('castle', 'api')
    expect(state().config?.realm).toEqual(realm)
  })

  it('clearing a building sends null', async () => {
    api.realm.setAssignment.mockResolvedValue(ok(defaultSettings().realm))
    await state().setAssignment('farm', null)
    expect(api.realm.setAssignment).toHaveBeenCalledWith('farm', null)
  })

  it('rejects with the fixed code and leaves the config alone', async () => {
    const before = state().config
    api.realm.setAssignment.mockResolvedValue(fail('NOT_FOUND'))
    await expect(state().setAssignment('castle', 'ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(state().config).toBe(before)
  })

  it('with no config loaded yet, nothing is invented', async () => {
    useSettingsStore.setState({ config: null })
    api.realm.setAssignment.mockResolvedValue(ok(defaultSettings().realm))
    await state().setAssignment('castle', null)
    expect(state().config).toBeNull()
  })
})

describe('setExclusions', () => {
  it('stores what main saved', async () => {
    api.discovery.setExclusions.mockResolvedValue(ok(['vendor', 'big-data']))
    await state().setExclusions(['vendor', 'big-data'])
    expect(api.discovery.setExclusions).toHaveBeenCalledWith(['vendor', 'big-data'])
    expect(state().config?.discovery.exclusions).toEqual(['vendor', 'big-data'])
  })

  it('rejects on error and keeps the old list', async () => {
    api.discovery.setExclusions.mockResolvedValue(fail('CONFIG_WRITE_FAILED'))
    await expect(state().setExclusions(['x'])).rejects.toMatchObject({ code: 'CONFIG_WRITE_FAILED' })
    expect(state().config?.discovery.exclusions).toEqual([])
  })
})

describe('fetchStoreHealth', () => {
  it('stores the health of each store and both startup flags', async () => {
    const health = {
      stores: { settings: 'ok', workspaces: 'recovered-partial', sandbox: 'ok', sessionDefaults: 'absent' },
      configDirMismatch: true,
      legacyConfigPresent: true,
    }
    api.config.getStoreHealth.mockResolvedValue(ok(health))
    await state().fetchStoreHealth()
    expect(state().storeHealth).toEqual(health)
    expect(state().storeHealth?.legacyConfigPresent).toBe(true)
  })

  it('dismissing is per session and does not clear the health', async () => {
    api.config.getStoreHealth.mockResolvedValue(ok({ stores: {}, configDirMismatch: false, legacyConfigPresent: false }))
    await state().fetchStoreHealth()
    state().dismissStoreHealth()
    expect(state().storeHealthDismissed).toBe(true)
    expect(state().storeHealth).not.toBeNull()
  })
})

describe('fetchConfig / updateConfig', () => {
  it('fetchConfig stores the Settings', async () => {
    api.config.get.mockResolvedValue(ok({ ...defaultSettings(), companyName: 'Acme' }))
    await state().fetchConfig()
    expect(state().config?.companyName).toBe('Acme')
  })

  it('updateConfig never sends the realm mapping, whatever the caller spread in', async () => {
    api.config.update.mockResolvedValue(ok(defaultSettings()))
    const realm = { ...defaultSettings().realm, mapping: [{ location: 'castle' as const, workspaceSlug: 'api' }], villagerDensity: 'high' as const }
    await state().updateConfig({ realm })
    const sent = api.config.update.mock.calls[0][0] as { realm: Record<string, unknown> }
    expect(sent.realm).not.toHaveProperty('mapping')
    expect(sent.realm.villagerDensity).toBe('high')
    expect(sent.realm.enabled).toBe(realm.enabled)
  })

  it('updateConfig leaves a request without realm alone', async () => {
    api.config.update.mockResolvedValue(ok(defaultSettings()))
    await state().updateConfig({ companyName: 'X' })
    expect(api.config.update).toHaveBeenCalledWith({ companyName: 'X' })
  })

  it('updateConfig replaces the config with the saved Settings', async () => {
    api.config.update.mockResolvedValue(ok({ ...defaultSettings(), companyName: 'NewCo' }))
    await state().updateConfig({ companyName: 'NewCo' })
    expect(api.config.update).toHaveBeenCalledWith({ companyName: 'NewCo' })
    expect(state().config?.companyName).toBe('NewCo')
  })
})
