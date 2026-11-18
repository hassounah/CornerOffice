import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import { unwrapIpc } from '../../utils/ipc'
import type { IpcResponse } from '../../utils/ipc'
import { CONFIG_DIR_MISMATCH_COPY, isDamagedStoreHealth, storeHealthMessage, workspaceErrorMessage } from '../../utils/workspace-errors'

// ---------------------------------------------------------------------------
// StoreHealthNotice — tells the user when a settings or registry file had to be repaired (#0039, TRD §4.9, UX M10).
//
// Shown at the top of the workspace manager in both skins and in the empty states. It reads the store health itself
// (fetching it once when it is not loaded yet) and renders nothing when every store is `ok` or `absent`, when the
// settings folder is the one Electron uses, or when the user dismissed it for this session. "Reveal in folder" sends
// a store NAME; main finds the file itself and never takes a path from the renderer.
// ---------------------------------------------------------------------------

type StoreName = 'settings' | 'workspaces' | 'sandbox' | 'sessionDefaults'

/** The file each store keeps in the config dir (mirrors main's `STORE_LABELS`, which the renderer cannot import: it uses fs). */
const STORE_FILES: Readonly<Record<StoreName, string>> = {
  settings: 'settings.json',
  workspaces: 'workspaces.json',
  sandbox: 'sandbox.json',
  sessionDefaults: 'session-defaults.json',
}

const STORE_NAMES = Object.keys(STORE_FILES) as StoreName[]

/** Used when main does not say where the settings live. */
const DEFAULT_CONFIG_DIR_DISPLAY = '~/.config/corner-office'

export function StoreHealthNotice(): React.ReactElement | null {
  const health = useSettingsStore((s) => s.storeHealth)
  const dismissed = useSettingsStore((s) => s.storeHealthDismissed)
  const fetchStoreHealth = useSettingsStore((s) => s.fetchStoreHealth)
  const dismiss = useSettingsStore((s) => s.dismissStoreHealth)
  const [revealError, setRevealError] = useState<string | null>(null)

  useEffect(() => {
    if (health === null) fetchStoreHealth().catch(() => undefined)
  }, [health, fetchStoreHealth])

  if (health === null || dismissed) return null

  const damaged = STORE_NAMES.filter((name) => isDamagedStoreHealth(health.stores[name]))
  const mismatch = health.configDirMismatch
  if (damaged.length === 0 && !mismatch) return null

  async function reveal(store: StoreName): Promise<void> {
    setRevealError(null)
    try {
      unwrapIpc(await window.cornerOffice.config.revealStoreFile(store) as IpcResponse<unknown>)
    } catch (err) {
      setRevealError(workspaceErrorMessage((err as { code?: string }).code))
    }
  }

  const configDirDisplay = health.configDirDisplay ?? DEFAULT_CONFIG_DIR_DISPLAY
  const revealButton = 'text-xs px-2 py-1 rounded bg-co-bg-tertiary text-co-text-secondary hover:text-co-text-primary transition-colors'

  return (
    <div role="status" className="rounded-lg border border-co-status-attention/40 bg-co-status-attention/10 p-3 text-sm text-co-text-primary" data-testid="store-health-notice">
      <ul className="flex flex-col gap-2">
        {damaged.map((name) => {
          const file = STORE_FILES[name]
          const state = health.stores[name]
          return (
            <li key={name} className="flex items-start justify-between gap-3">
              <span>{isDamagedStoreHealth(state) ? storeHealthMessage(name, state, health.details?.[name]?.corruptName) : null}</span>
              <button type="button" className={revealButton} onClick={() => void reveal(name)} aria-label={`Reveal ${file} in folder`}>
                Reveal in folder
              </button>
            </li>
          )
        })}
        {mismatch && <li>{CONFIG_DIR_MISMATCH_COPY(configDirDisplay)}</li>}
      </ul>
      {revealError && (
        <p role="alert" className="mt-2 text-xs text-co-status-attention">
          {revealError}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <button type="button" className={revealButton} onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
