import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import { LEGACY_NOTICE_COPY, workspaceErrorMessage } from '../../utils/workspace-errors'

// ---------------------------------------------------------------------------
// LegacyNotice — the one-time upgrade notice (#0039 UX H1). While an old `config.json` is still in the data folder,
// it says the earlier workspace list and sandbox settings were not carried over, wherever the user is (not only on the
// empty-registry screen). Dismissing it is saved in settings.json (`legacyNoticeDismissed`), so it stays gone.
// ---------------------------------------------------------------------------

export interface LegacyNoticeProps {
  /** `realm` uses the realm's own palette: the office tokens are not set on its shell. */
  skin: 'office' | 'realm'
}

export function LegacyNotice({ skin }: LegacyNoticeProps): React.ReactElement | null {
  const legacyConfigPresent = useSettingsStore((s) => s.storeHealth?.legacyConfigPresent ?? false)
  const healthLoaded = useSettingsStore((s) => s.storeHealth !== null)
  const config = useSettingsStore((s) => s.config)
  const fetchStoreHealth = useSettingsStore((s) => s.fetchStoreHealth)
  const updateConfig = useSettingsStore((s) => s.updateConfig)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!healthLoaded) fetchStoreHealth().catch(() => undefined)
  }, [healthLoaded, fetchStoreHealth])

  // Settings not loaded yet: say nothing rather than flash a notice that may already be dismissed.
  if (!legacyConfigPresent || config === null || config.legacyNoticeDismissed) return null

  async function dismiss(): Promise<void> {
    setError(null)
    try {
      await updateConfig({ legacyNoticeDismissed: true })
    } catch (err) {
      setError(workspaceErrorMessage((err as { code?: string }).code))
    }
  }

  const realm = skin === 'realm'
  return (
    <div
      role="status"
      data-testid="legacy-notice"
      className={`flex items-start justify-between gap-3 p-3 text-sm ${realm ? 'font-serif' : 'rounded-lg border border-co-status-attention/40 bg-co-status-attention/10 text-co-text-primary'}`}
      style={realm ? { background: '#2a1d0e', border: '1px solid rgba(201, 168, 76, 0.5)', color: '#e8d5a3' } : undefined}
    >
      <div>
        <p>{LEGACY_NOTICE_COPY}</p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-co-status-attention">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => void dismiss()}
        className={realm ? 'text-xs px-2 py-1 rounded' : 'text-xs px-2 py-1 rounded bg-co-bg-tertiary text-co-text-secondary hover:text-co-text-primary transition-colors'}
        style={realm ? { border: '1px solid rgba(201, 168, 76, 0.4)', color: '#e8d5a3' } : undefined}
      >
        Dismiss
      </button>
    </div>
  )
}
