import React, { useState, useRef } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { useGuardDialogStore } from '../../hooks/useUnsavedGuard'
import type { AppConfig } from '@main/types/config'

type ShipStyle = AppConfig['appearance']['shipMomentStyle']

const VIEW_OPTIONS: Array<{ value: 'corner-office' | 'corner-realm'; label: string }> = [
  { value: 'corner-office', label: 'Corner Office' },
  { value: 'corner-realm',  label: 'Corner Realm' },
]

const SHIP_OPTIONS: Array<{ value: ShipStyle; label: string; description: string }> = [
  { value: 'full',    label: 'Full',    description: 'Animated overlay with confetti' },
  { value: 'compact', label: 'Compact', description: 'Small toast notification' },
  { value: 'off',     label: 'Off',     description: 'No celebration' },
]

export function AppearanceSettings(): React.ReactElement {
  const config = useSettingsStore((s) => s.config)
  const updateConfig = useSettingsStore((s) => s.updateConfig)
  const fontSizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [companyError, setCompanyError] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState(config?.companyName ?? '')

  if (!config) return <div className="text-co-text-muted text-base">Loading…</div>

  const { appearance } = config

  const realmEnabled = config.realm?.enabled ?? false

  function handleViewChange(view: 'corner-office' | 'corner-realm'): void {
    const doSwitch = () => {
      void updateConfig({ realm: { ...config!.realm, enabled: view === 'corner-realm' } })
        .catch((e: unknown) => { console.error(e) })
    }
    // Guard: if a document is being edited, confirm before switching skin (§17 R9)
    if (useDocViewerStore.getState().isDirty()) {
      useGuardDialogStore.getState().requestConfirm(doSwitch)
    } else {
      doSwitch()
    }
  }

  async function handleShipStyleChange(shipMomentStyle: ShipStyle): Promise<void> {
    try {
      await updateConfig({ appearance: { ...appearance, shipMomentStyle } })
    } catch (e) {
      console.error(e)
    }
  }

  async function handleCompactToggle(compactView: boolean): Promise<void> {
    try {
      await updateConfig({ appearance: { ...appearance, compactView } })
    } catch (e) {
      console.error(e)
    }
  }

  async function handleCompanyNameSave(): Promise<void> {
    const trimmed = companyName.trim()
    if (!trimmed) {
      setCompanyError('Company name cannot be empty')
      return
    }
    setCompanyError(null)
    try {
      await updateConfig({ companyName: trimmed })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setCompanyError(msg)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Company name */}
      <section>
        <h3 className="text-base font-semibold text-co-text-primary mb-3">Company</h3>
        <div className="max-w-sm">
          <label htmlFor="company-name" className="block text-sm text-co-text-secondary mb-1">
            Company Name
          </label>
          <div className="flex gap-2">
            <input
              id="company-name"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              onBlur={() => void handleCompanyNameSave()}
              className={[
                'flex-1 px-3 py-2 rounded-md bg-co-bg-tertiary border text-base text-co-text-primary',
                'focus:outline-none focus:border-co-accent',
                companyError ? 'border-red-500' : 'border-co-border',
              ].join(' ')}
              aria-describedby={companyError ? 'company-error' : undefined}
            />
          </div>
          {companyError && (
            <p id="company-error" className="text-sm text-red-400 mt-1" role="alert">
              {companyError}
            </p>
          )}
        </div>
      </section>

      {/* Theme (view toggle) */}
      <section>
        <h3 className="text-base font-semibold text-co-text-primary mb-3">Theme</h3>
        <div className="flex gap-2" role="group" aria-label="Theme selection">
          {VIEW_OPTIONS.map((opt) => {
            const isSelected = opt.value === 'corner-realm' ? realmEnabled : !realmEnabled
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => void handleViewChange(opt.value)}
                className={[
                  'px-4 py-2 rounded-md text-base font-medium border transition-colors',
                  isSelected
                    ? 'bg-co-accent text-white border-co-accent'
                    : 'bg-co-bg-tertiary text-co-text-secondary border-co-border hover:text-co-text-primary',
                ].join(' ')}
                aria-pressed={isSelected}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </section>

      {/* Compact view */}
      <section>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-co-text-primary">Compact View</h3>
            <p className="text-sm text-co-text-muted mt-0.5">Denser layout with smaller text</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={appearance.compactView}
            onClick={() => void handleCompactToggle(!appearance.compactView)}
            className={[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              appearance.compactView ? 'bg-co-accent' : 'bg-co-bg-tertiary',
            ].join(' ')}
          >
            <span
              className={[
                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                appearance.compactView ? 'translate-x-6' : 'translate-x-1',
              ].join(' ')}
            />
            <span className="sr-only">{appearance.compactView ? 'Disable' : 'Enable'} compact view</span>
          </button>
        </div>
      </section>

      {/* Ship celebrations */}
      <section>
        <h3 className="text-base font-semibold text-co-text-primary mb-1">Ship Celebrations</h3>
        <p className="text-sm text-co-text-muted mb-3">How to celebrate when a feature ships</p>
        <div className="flex flex-col gap-2">
          {SHIP_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={[
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                appearance.shipMomentStyle === opt.value
                  ? 'border-co-accent bg-co-accent/10'
                  : 'border-co-border bg-co-bg-secondary hover:bg-co-bg-tertiary',
              ].join(' ')}
            >
              <input
                type="radio"
                name="ship-style"
                value={opt.value}
                checked={appearance.shipMomentStyle === opt.value}
                onChange={() => void handleShipStyleChange(opt.value)}
                className="sr-only"
              />
              <div className={[
                'h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0',
                appearance.shipMomentStyle === opt.value
                  ? 'border-co-accent'
                  : 'border-co-border',
              ].join(' ')}>
                {appearance.shipMomentStyle === opt.value && (
                  <div className="h-2 w-2 rounded-full bg-co-accent" />
                )}
              </div>
              <div>
                <span className="text-base font-medium text-co-text-primary">{opt.label}</span>
                <p className="text-sm text-co-text-muted">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </section>

      {/* Terminal */}
      <section>
        <h3 className="text-base font-semibold text-co-text-primary mb-3">Terminal</h3>
        <div className="max-w-sm">
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="terminal-font-size" className="text-sm text-co-text-secondary">
              Font Size
            </label>
            <span className="text-sm font-medium text-co-text-primary tabular-nums">
              {config.terminal?.fontSize ?? 14}
            </span>
          </div>
          <input
            id="terminal-font-size"
            type="range"
            min={10}
            max={20}
            step={1}
            value={config.terminal?.fontSize ?? 14}
            onChange={(e) => {
              const newSize = Number(e.target.value)
              if (fontSizeTimerRef.current !== null) clearTimeout(fontSizeTimerRef.current)
              fontSizeTimerRef.current = setTimeout(() => {
                void updateConfig({ terminal: { fontSize: newSize } } as Partial<AppConfig>)
                fontSizeTimerRef.current = null
              }, 120)
            }}
            className="w-full accent-co-accent"
          />
          <div className="flex justify-between text-xs text-co-text-muted mt-1">
            <span>10</span>
            <span>20</span>
          </div>
        </div>
      </section>
    </div>
  )
}
