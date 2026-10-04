import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settings-store'
import { useSandboxStore } from '../stores/sandbox-store'
import { AppearanceSettings } from '../components/settings/AppearanceSettings'
import { NotificationSettings } from '../components/settings/NotificationSettings'
import { HookSettings } from '../components/settings/HookSettings'
import { WorkspaceSettings } from '../components/settings/WorkspaceSettings'
import { SandboxSettingsPanel } from '../components/sandbox/SandboxSettingsPanel'

type Tab = 'workspaces' | 'notifications' | 'hooks' | 'sandbox' | 'appearance'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'workspaces',    label: 'Workspaces' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'hooks',         label: 'Hooks' },
  { id: 'sandbox',       label: 'Sandbox' },
  { id: 'appearance',   label: 'Appearance' },
]

export default function Settings(): React.ReactElement {
  const fetchConfig = useSettingsStore((s) => s.fetchConfig)
  const loading = useSettingsStore((s) => s.loading)
  const error = useSettingsStore((s) => s.error)
  // A "blocked a network request" notification click asks for Sandbox settings with that workspace selected
  // (`settingsRequest`). Read once at mount; the subscription below handles a Settings that is already open.
  const [activeTab, setActiveTab] = useState<Tab>(() => (useSandboxStore.getState().settingsRequest !== null ? 'sandbox' : 'workspaces'))
  const [initialWorkspace, setInitialWorkspace] = useState<string | undefined>(() => useSandboxStore.getState().settingsRequest || undefined)

  useEffect(() => {
    void fetchConfig()
  }, [fetchConfig])

  useEffect(() => {
    // Consumed means cleared, so the request never fires a second time.
    if (useSandboxStore.getState().settingsRequest !== null) useSandboxStore.getState().clearSettingsRequest()
    return useSandboxStore.subscribe((state) => {
      const requested = state.settingsRequest
      if (requested === null) return
      setActiveTab('sandbox')
      setInitialWorkspace(requested || undefined)
      useSandboxStore.getState().clearSettingsRequest()
    })
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-co-text-muted text-sm">Loading settings…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-red-400 text-sm">Failed to load settings: {error}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left nav */}
      <div
        role="tablist"
        aria-label="Settings sections"
        className="w-48 shrink-0 border-r border-white/[0.04] flex flex-col py-4 gap-0.5 px-2"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            id={`settings-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
              activeTab === tab.id
                ? 'bg-co-accent/10 text-co-accent font-medium'
                : 'text-co-text-secondary hover:text-co-text-primary hover:bg-co-bg-tertiary',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Panel */}
      <main className="flex-1 overflow-y-auto p-6">
        <div
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
        >
          <h2 className="text-base font-semibold text-co-text-primary mb-6">
            {TABS.find((t) => t.id === activeTab)?.label}
          </h2>

          {activeTab === 'workspaces' && <WorkspaceSettings />}
          {activeTab === 'notifications' && <NotificationSettings />}
          {activeTab === 'hooks' && <HookSettings />}
          {/* Keyed by the requested workspace, so a second request while open re-selects it. */}
          {activeTab === 'sandbox' && <SandboxSettingsPanel key={initialWorkspace ?? ''} skin="office" initialWorkspace={initialWorkspace} />}
          {activeTab === 'appearance' && <AppearanceSettings />}
        </div>
      </main>
    </div>
  )
}
