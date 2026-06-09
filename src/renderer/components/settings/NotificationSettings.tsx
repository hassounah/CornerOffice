import React from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import type { AppConfig } from '@main/types/config'

type NotificationConfig = AppConfig['notifications']

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
        checked ? 'bg-co-accent' : 'bg-co-bg-tertiary',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-5' : 'translate-x-1',
        ].join(' ')}
      />
    </button>
  )
}

export function NotificationSettings(): React.ReactElement {
  const config = useSettingsStore((s) => s.config)
  const updateConfig = useSettingsStore((s) => s.updateConfig)

  if (!config) return <div className="text-co-text-muted text-base">Loading…</div>

  const { notifications: notif } = config

  async function updateTier<K extends keyof NotificationConfig['tiers']>(
    tier: K,
    patch: Partial<NotificationConfig['tiers'][K]>,
  ): Promise<void> {
    try {
      await updateConfig({
        notifications: {
          ...notif,
          tiers: {
            ...notif.tiers,
            [tier]: { ...notif.tiers[tier], ...patch },
          },
        },
      })
    } catch (e) {
      console.error(e)
    }
  }

  async function updateQuietHours(
    patch: Partial<NotificationConfig['quietHours']>,
  ): Promise<void> {
    try {
      await updateConfig({
        notifications: {
          ...notif,
          quietHours: { ...notif.quietHours, ...patch },
        },
      })
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Tier toggles */}
      <section>
        <h3 className="text-base font-semibold text-co-text-primary mb-3">Notification Tiers</h3>
        <div className="flex flex-col gap-0 rounded-lg border border-white/[0.04] overflow-hidden">
          {/* RequiresAction — always enabled */}
          <div className="flex items-center justify-between p-3 bg-co-bg-elevated border-b border-white/[0.04]">
            <div>
              <p className="text-base font-medium text-co-text-primary">Action Required</p>
              <p className="text-sm text-co-text-muted">Always enabled — cannot be turned off</p>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm text-co-text-muted">
                <Toggle
                  checked={notif.tiers.requiresAction.sound}
                  onChange={(v) => void updateTier('requiresAction', { sound: v })}
                  label="Action Required sound"
                />
                Sound
              </label>
              <Toggle checked={true} onChange={() => {}} disabled label="Action Required enabled" />
            </div>
          </div>

          {/* Idle */}
          <div className="flex items-center justify-between p-3 bg-co-bg-elevated border-b border-white/[0.04]">
            <div>
              <p className="text-base font-medium text-co-text-primary">Idle</p>
              <p className="text-sm text-co-text-muted">Alert when a workspace with an active pipeline goes quiet</p>
            </div>
            <div className="flex items-center gap-3">
              {notif.tiers.idle.enabled && (
                <label className="flex items-center gap-1.5 text-sm text-co-text-muted">
                  <Toggle
                    checked={notif.tiers.idle.osNotification}
                    onChange={(v) => void updateTier('idle', { osNotification: v })}
                    label="Idle OS notification"
                  />
                  OS alert
                </label>
              )}
              <Toggle
                checked={notif.tiers.idle.enabled}
                onChange={(v) => void updateTier('idle', { enabled: v })}
                label="Idle enabled"
              />
            </div>
          </div>

          {/* Progress */}
          <div className="flex items-center justify-between p-3 bg-co-bg-elevated border-b border-white/[0.04]">
            <div>
              <p className="text-base font-medium text-co-text-primary">Progress</p>
              <p className="text-sm text-co-text-muted">Milestone completions and updates</p>
            </div>
            <div className="flex items-center gap-3">
              {notif.tiers.progress.enabled && (
                <label className="flex items-center gap-1.5 text-sm text-co-text-muted">
                  <Toggle
                    checked={notif.tiers.progress.osNotification}
                    onChange={(v) => void updateTier('progress', { osNotification: v })}
                    label="Progress OS notification"
                  />
                  OS alert
                </label>
              )}
              <Toggle
                checked={notif.tiers.progress.enabled}
                onChange={(v) => void updateTier('progress', { enabled: v })}
                label="Progress enabled"
              />
            </div>
          </div>

          {/* Activity */}
          <div className="flex items-center justify-between p-3 bg-co-bg-elevated">
            <div>
              <p className="text-base font-medium text-co-text-primary">Activity</p>
              <p className="text-sm text-co-text-muted">Feed only — no OS alerts</p>
            </div>
            <Toggle
              checked={notif.tiers.activity.enabled}
              onChange={(v) => void updateTier('activity', { enabled: v })}
              label="Activity enabled"
            />
          </div>
        </div>
      </section>

      {/* Idle threshold */}
      {notif.tiers.idle.enabled && (
        <section>
          <h3 className="text-base font-semibold text-co-text-primary mb-3">Idle Threshold</h3>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={1}
              max={30}
              step={1}
              value={notif.idleThresholdMinutes}
              onChange={(e) => {
                void updateConfig({
                  notifications: {
                    ...notif,
                    idleThresholdMinutes: Number(e.target.value),
                  },
                })
              }}
              className="flex-1 accent-co-accent"
              aria-label="Idle threshold in minutes"
            />
            <span className="text-base text-co-text-secondary tabular-nums w-16 text-right">
              {notif.idleThresholdMinutes} min
            </span>
          </div>
          <p className="text-sm text-co-text-muted mt-1">
            Alert after a workspace with an active pipeline has been quiet for this long
          </p>
        </section>
      )}

      {/* Show missed on startup */}
      <section>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-co-text-primary">
              Show Missed Notifications on Startup
            </h3>
            <p className="text-sm text-co-text-muted mt-0.5">
              Show OS notifications for events that occurred while the app was closed
            </p>
          </div>
          <Toggle
            checked={notif.showMissedOnStartup}
            onChange={(v) => {
              void updateConfig({
                notifications: { ...notif, showMissedOnStartup: v },
              })
            }}
            label="Show missed notifications on startup"
          />
        </div>
      </section>

      {/* Quiet hours */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold text-co-text-primary">Quiet Hours</h3>
            <p className="text-sm text-co-text-muted mt-0.5">Suppress OS alerts during these hours</p>
          </div>
          <Toggle
            checked={notif.quietHours.enabled}
            onChange={(v) => void updateQuietHours({ enabled: v })}
            label="Quiet hours enabled"
          />
        </div>
        {notif.quietHours.enabled && (
          <div className="flex items-center gap-3 mt-2">
            <label className="text-sm text-co-text-secondary">
              From
              <input
                type="time"
                value={notif.quietHours.start}
                onChange={(e) => void updateQuietHours({ start: e.target.value })}
                className="ml-2 px-2 py-1 rounded bg-co-bg-tertiary border border-white/[0.04] text-base text-co-text-primary focus:outline-none focus:border-co-accent"
              />
            </label>
            <label className="text-sm text-co-text-secondary">
              To
              <input
                type="time"
                value={notif.quietHours.end}
                onChange={(e) => void updateQuietHours({ end: e.target.value })}
                className="ml-2 px-2 py-1 rounded bg-co-bg-tertiary border border-white/[0.04] text-base text-co-text-primary focus:outline-none focus:border-co-accent"
              />
            </label>
          </div>
        )}
      </section>
    </div>
  )
}
