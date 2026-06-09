import React, { useCallback, useEffect, useState } from 'react'
import { MINIMUM_PLUGIN_VERSION } from '@main/types/channels'
import type { PluginStatus as PluginStatusType } from '@main/types/channels'
import { unwrapIpc } from '../../utils/ipc'

type BadgeStyle = { wrapper: string; dot: string; label: string }

const PLUGIN_BADGE_STYLES: Record<'green' | 'yellow' | 'gray', BadgeStyle> = {
  green: {
    wrapper: 'bg-green-900/40 text-green-300',
    dot: 'bg-green-400',
    label: 'Installed',
  },
  yellow: {
    wrapper: 'bg-amber-900/40 text-amber-300',
    dot: 'bg-amber-400',
    label: 'Update required',
  },
  gray: {
    wrapper: 'bg-stone-800/60 text-stone-400',
    dot: 'bg-stone-500',
    label: 'Not installed',
  },
}

const EVENTS_BADGE_STYLES: Record<'green' | 'orange', BadgeStyle> = {
  green: {
    wrapper: 'bg-green-900/40 text-green-300',
    dot: 'bg-green-400',
    label: 'Active',
  },
  orange: {
    wrapper: 'bg-orange-900/40 text-orange-300',
    dot: 'bg-orange-400',
    label: 'Hooks not installed',
  },
}

function pluginBadgeVariant(status: PluginStatusType): 'green' | 'yellow' | 'gray' {
  if (!status.installed) return 'gray'
  if (!status.meetsMinimumVersion) return 'yellow'
  return 'green'
}

function eventsBadgeVariant(status: PluginStatusType): 'green' | 'orange' {
  return status.eventsEnabled ? 'green' : 'orange'
}

/**
 * Displays the Corner Office Claude Code plugin installation status.
 * Shows a badge with install guidance and a Refresh button.
 */
export function PluginStatus(): React.ReactElement {
  const [status, setStatus] = useState<PluginStatusType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hooksLoading, setHooksLoading] = useState(false)
  const [hooksError, setHooksError] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await window.cornerOffice.plugin.getStatus()
      setStatus(unwrapIpc(response))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const handleInstallHooks = useCallback(async () => {
    setHooksLoading(true)
    setHooksError(null)
    try {
      const response = await window.cornerOffice.plugin.installHooks()
      unwrapIpc(response)
      await fetchStatus()
    } catch (e) {
      setHooksError(e instanceof Error ? e.message : String(e))
    } finally {
      setHooksLoading(false)
    }
  }, [fetchStatus])

  const handleUninstallHooks = useCallback(async () => {
    setHooksLoading(true)
    setHooksError(null)
    try {
      const response = await window.cornerOffice.plugin.uninstallHooks()
      unwrapIpc(response)
      await fetchStatus()
    } catch (e) {
      setHooksError(e instanceof Error ? e.message : String(e))
    } finally {
      setHooksLoading(false)
    }
  }, [fetchStatus])

  const pluginVariant = status ? pluginBadgeVariant(status) : 'gray'
  const pluginStyles = PLUGIN_BADGE_STYLES[pluginVariant]

  const showHooksSection = status?.installed && status.meetsMinimumVersion

  return (
    <section aria-labelledby="plugin-status-heading">
      <h3 id="plugin-status-heading" className="text-base font-semibold text-co-text-primary mb-1">
        Claude Code Plugin
      </h3>
      <p className="text-sm text-co-text-muted mb-4 max-w-lg">
        Corner Office requires the{' '}
        <code className="font-mono text-co-text-secondary">corner-office</code> plugin to receive
        real-time events from Claude Code sessions.
      </p>

      {/* Status badge */}
      <div className="flex items-center gap-3 mb-4">
        {loading ? (
          <span className="text-sm text-co-text-muted">Checking…</span>
        ) : error ? (
          <span className="text-sm text-red-400" role="alert">{error}</span>
        ) : status ? (
          <span
            className={`inline-flex items-center gap-1.5 text-sm font-medium px-2.5 py-1 rounded-full ${pluginStyles.wrapper}`}
            aria-label={`Plugin status: ${pluginStyles.label}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${pluginStyles.dot}`} aria-hidden="true" />
            {pluginStyles.label}
          </span>
        ) : null}

        {status?.installed && status.version && (
          <span className="text-sm text-co-text-muted">v{status.version}</span>
        )}
      </div>

      {/* Version mismatch message */}
      {status?.installed && !status.meetsMinimumVersion && status.version && (
        <p className="text-sm text-amber-400/80 mb-4">
          Version {status.version} installed. Version {MINIMUM_PLUGIN_VERSION} required.
        </p>
      )}

      {/* Onboarding / install instructions */}
      {!status?.installed && !loading && (
        <div className="mb-4 rounded-md bg-stone-900/60 border border-stone-700/40 p-3">
          <p className="text-sm text-co-text-muted mb-2">Install via the Claude Code CLI:</p>
          <code className="block font-mono text-sm text-amber-300 bg-black/30 rounded px-2 py-1.5 mb-1.5">
            claude plugin marketplace add hassounah/amerh
          </code>
          <code className="block font-mono text-sm text-amber-300 bg-black/30 rounded px-2 py-1.5">
            claude plugin install corner-office@amerh
          </code>
        </div>
      )}

      {/* Event hooks section — only shown when plugin installed and meets minimum version */}
      {showHooksSection && status && (
        <div className="mb-4" role="group" aria-labelledby="event-hooks-heading">
          <h4 id="event-hooks-heading" className="text-sm font-semibold text-co-text-secondary mb-1">
            Event Hooks
          </h4>
          <p className="text-sm text-co-text-muted mb-2">
            {status.eventsEnabled
              ? 'Real-time activity from Claude Code sessions is active.'
              : 'Enable event hooks to receive real-time activity from Claude Code sessions.'}
          </p>

          {/* Events status badge */}
          <div className="flex items-center gap-3 mb-2">
            {(() => {
              const eventsVariant = eventsBadgeVariant(status)
              const eventsStyles = EVENTS_BADGE_STYLES[eventsVariant]
              return (
                <span
                  className={`inline-flex items-center gap-1.5 text-sm font-medium px-2.5 py-1 rounded-full ${eventsStyles.wrapper}`}
                  aria-label={`Events status: ${eventsStyles.label}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${eventsStyles.dot}`} aria-hidden="true" />
                  {eventsStyles.label}
                </span>
              )
            })()}
          </div>

          <div className="flex items-center gap-2">
            {status.eventsEnabled ? (
              <button
                type="button"
                onClick={() => void handleUninstallHooks()}
                disabled={hooksLoading}
                aria-busy={hooksLoading}
                aria-label="Uninstall event hooks"
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-stone-800/60 border border-stone-700/40 text-co-text-secondary hover:text-co-text-primary disabled:opacity-50 transition-colors"
              >
                {hooksLoading ? 'Uninstalling…' : 'Uninstall Hooks'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleInstallHooks()}
                disabled={hooksLoading}
                aria-busy={hooksLoading}
                aria-label="Install event hooks"
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-stone-800/60 border border-stone-700/40 text-co-text-secondary hover:text-co-text-primary disabled:opacity-50 transition-colors"
              >
                {hooksLoading ? 'Installing…' : 'Install Hooks'}
              </button>
            )}
          </div>
          {hooksError && (
            <p className="text-sm text-red-400 mt-2" role="alert">{hooksError}</p>
          )}
        </div>
      )}

      {/* Refresh button */}
      <button
        type="button"
        onClick={() => void fetchStatus()}
        disabled={loading}
        aria-busy={loading}
        className="px-3 py-1.5 rounded-md text-sm font-medium bg-stone-800/60 border border-stone-700/40 text-co-text-secondary hover:text-co-text-primary disabled:opacity-50 transition-colors"
      >
        {loading ? 'Checking…' : 'Refresh'}
      </button>
    </section>
  )
}
