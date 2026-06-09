import React, { useState, useEffect, useRef } from 'react'
import type { SettingsSectionId } from '@main/types/realm'
import type { RealmLocation } from '@main/types/config'
import { useSettingsStore } from '../../../stores/settings-store'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { HookSettings } from '../../settings/HookSettings'
import { NotificationSettings } from '../../settings/NotificationSettings'
import { AppearanceSettings } from '../../settings/AppearanceSettings'

// ---------------------------------------------------------------------------
// Asset imports
// ---------------------------------------------------------------------------

import settingsBg from '../../../../../assets/realm/settings/Settings_Chamber.png'
import scrollActive from '../../../../../assets/realm/settings/Settings_Scroll_Active.png'
import scrollInactive from '../../../../../assets/realm/settings/Settings_Scroll_Inactive.png'
import scrollDisabled from '../../../../../assets/realm/settings/Settings_Scroll_Disabled.png'
import btnKingdomActive from '../../../../../assets/realm/ui/buttons/Button_Kingdom_Active.png'
import btnKingdomInactive from '../../../../../assets/realm/ui/buttons/Button_Kingdom_Inactive.png'
import btnWorkspacesActive from '../../../../../assets/realm/ui/buttons/Button_Workspaces_Active.png'
import btnWorkspacesInactive from '../../../../../assets/realm/ui/buttons/Button_Workspaces_Inactive.png'
import btnHooksActive from '../../../../../assets/realm/ui/buttons/Button_Hooks_Active.png'
import btnHooksInactive from '../../../../../assets/realm/ui/buttons/Button_Hooks_Inactive.png'
import btnNotificationsActive from '../../../../../assets/realm/ui/buttons/Button_Notifications_Active.png'
import btnNotificationsInactive from '../../../../../assets/realm/ui/buttons/Button_Notifications_Inactive.png'
import btnAppearanceActive from '../../../../../assets/realm/ui/buttons/Button_Appearance_Active.png'
import btnAppearanceInactive from '../../../../../assets/realm/ui/buttons/Button_Appearance_Inactive.png'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECTIONS: SettingsSectionId[] = ['kingdom', 'workspaces', 'hooks', 'notifications', 'appearance']

const SECTION_LABELS: Record<SettingsSectionId, string> = {
  kingdom: 'Kingdom',
  workspaces: 'Workspaces',
  hooks: 'Hooks',
  notifications: 'Notifications',
  appearance: 'Appearance',
}

const SECTION_ACTIVE_ASSETS: Record<SettingsSectionId, string> = {
  kingdom: btnKingdomActive,
  workspaces: btnWorkspacesActive,
  hooks: btnHooksActive,
  notifications: btnNotificationsActive,
  appearance: btnAppearanceActive,
}

const SECTION_INACTIVE_ASSETS: Record<SettingsSectionId, string> = {
  kingdom: btnKingdomInactive,
  workspaces: btnWorkspacesInactive,
  hooks: btnHooksInactive,
  notifications: btnNotificationsInactive,
  appearance: btnAppearanceInactive,
}

const REALM_LOCATION_LABELS: Record<RealmLocation, string> = {
  castle: 'The Castle',
  barracks: 'The Barracks',
  library: 'The Library',
  blacksmith: 'The Blacksmith',
  farm: 'The Farm',
  merchant_house: 'Merchant House',
  observatory: 'The Observatory',
  stables: 'The Stables',
  chapel: 'The Chapel',
  cottage: 'The Cottage',
}

// ---------------------------------------------------------------------------
// Debounce hook
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// ---------------------------------------------------------------------------
// Section: Kingdom
// ---------------------------------------------------------------------------

function KingdomSection(): React.ReactElement {
  const config = useSettingsStore((s) => s.config)
  const updateConfig = useSettingsStore((s) => s.updateConfig)

  if (!config?.realm) return <div style={sectionLoadingStyle}>Loading…</div>

  const { realm } = config
  const animationsEnabled = realm.animationsEnabled ?? true

  function toggle(field: 'shipCelebration' | 'animationsEnabled', currentValue: boolean): void {
    void updateConfig({
      realm: {
        ...realm,
        ...(field === 'shipCelebration'
          ? { shipCelebration: currentValue ? 'off' : 'townSquare' }
          : { animationsEnabled: !currentValue }),
      },
    })
  }

  return (
    <div style={sectionContentStyle}>
      <h3 style={sectionHeadingStyle}>Kingdom Settings</h3>

      <ScrollRow label="Ship Celebration" description="Show town square celebration when a feature ships" state={realm.shipCelebration === 'townSquare' ? 'active' : 'inactive'}>
        <ToggleSwitch
          checked={realm.shipCelebration === 'townSquare'}
          label="Ship celebration"
          onChange={() => toggle('shipCelebration', realm.shipCelebration === 'townSquare')}
        />
      </ScrollRow>

      <ScrollRow label="Animations" description="Character movement and building glow effects" state={animationsEnabled ? 'active' : 'inactive'}>
        <ToggleSwitch
          checked={animationsEnabled}
          label="Animations"
          onChange={() => toggle('animationsEnabled', animationsEnabled)}
        />
      </ScrollRow>

      {realm.shipCelebration === 'townSquare' && (
        <ScrollRow label="Celebration Duration" description="How long the ship celebration displays" state="active">
          <div style={{ display: 'flex', gap: 2 }} role="group" aria-label="Celebration duration">
            {([3000, 5000, 8000] as const).map((ms) => {
              const isSelected = (realm.celebrationDurationMs ?? 5000) === ms
              return (
                <button
                  key={ms}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => void updateConfig({ realm: { ...realm, celebrationDurationMs: ms } })}
                  style={{
                    padding: '4px 12px',
                    fontSize: 16,
                    background: isSelected ? 'rgba(201,168,76,0.25)' : 'rgba(10,6,2,0.5)',
                    border: '1px solid rgba(201,168,76,0.4)',
                    borderRadius: 4,
                    color: isSelected ? '#c9a84c' : '#e8d5a3',
                    cursor: 'pointer',
                    fontWeight: isSelected ? 700 : 500,
                    textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                  }}
                >
                  {ms / 1000}s
                </button>
              )
            })}
          </div>
        </ScrollRow>
      )}

      <ScrollRow label="Villager Density" description="How many villager characters appear in the kingdom" state="active">
        <div style={{ display: 'flex', gap: 2 }} role="group" aria-label="Villager density">
          {(['low', 'medium', 'high'] as const).map((level) => {
            const isSelected = (realm.villagerDensity ?? 'medium') === level
            return (
              <button
                key={level}
                type="button"
                aria-pressed={isSelected}
                onClick={() => void updateConfig({ realm: { ...realm, villagerDensity: level } })}
                style={{
                  padding: '3px 10px',
                  fontSize: 14,
                  background: isSelected ? 'rgba(201,168,76,0.25)' : 'rgba(10,6,2,0.5)',
                  border: '1px solid rgba(201,168,76,0.4)',
                  borderRadius: 4,
                  color: isSelected ? '#c9a84c' : '#e8d5a3',
                  cursor: 'pointer',
                  fontWeight: isSelected ? 700 : 500,
                  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                  textTransform: 'capitalize',
                }}
              >
                {level}
              </button>
            )
          })}
        </div>
      </ScrollRow>

      <ScrollRow label="Agent Density" description="How many agent characters appear in the kingdom" state="active">
        <div style={{ display: 'flex', gap: 2 }} role="group" aria-label="Agent density">
          {(['low', 'medium', 'high'] as const).map((level) => {
            const isSelected = (realm.agentDensity ?? 'medium') === level
            return (
              <button
                key={level}
                type="button"
                aria-pressed={isSelected}
                onClick={() => void updateConfig({ realm: { ...realm, agentDensity: level } })}
                style={{
                  padding: '3px 10px',
                  fontSize: 14,
                  background: isSelected ? 'rgba(201,168,76,0.25)' : 'rgba(10,6,2,0.5)',
                  border: '1px solid rgba(201,168,76,0.4)',
                  borderRadius: 4,
                  color: isSelected ? '#c9a84c' : '#e8d5a3',
                  cursor: 'pointer',
                  fontWeight: isSelected ? 700 : 500,
                  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                  textTransform: 'capitalize',
                }}
              >
                {level}
              </button>
            )
          })}
        </div>
      </ScrollRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section: Workspaces
// ---------------------------------------------------------------------------

function WorkspacesSection(): React.ReactElement {
  const config = useSettingsStore((s) => s.config)
  const updateConfig = useSettingsStore((s) => s.updateConfig)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  const [localMapping, setLocalMapping] = useState(() => config?.realm?.mapping ?? [])
  const debouncedMapping = useDebounce(localMapping, 300)
  const isFirstRender = useRef(true)

  // Sync debounced mapping to config (skip initial render)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    if (!config?.realm) return
    void updateConfig({ realm: { ...config.realm, mapping: debouncedMapping } })
  }, [debouncedMapping]) // eslint-disable-line -- intentional: updateConfig and config.realm are stable store refs

  if (!config?.realm) return <div style={sectionLoadingStyle}>Loading…</div>

  const assignedSlugs = new Set(
    localMapping.filter((m) => m.workspaceSlug !== null).map((m) => m.workspaceSlug as string),
  )

  function handleChange(location: RealmLocation, slug: string | null): void {
    setLocalMapping((prev) =>
      prev.map((m) => (m.location === location ? { ...m, workspaceSlug: slug } : m)),
    )
  }

  return (
    <div style={sectionContentStyle}>
      <h3 style={sectionHeadingStyle}>Workspace Assignments</h3>
      <p style={{ ...settingDescStyle, marginBottom: 12 }}>
        Assign each workspace to a building. Unassigned buildings appear dim on the map.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 600, overflowY: 'auto' }}>
        {localMapping.map(({ location, workspaceSlug }) => {
          const available = workspaces.filter(
            (w) => w.slug === workspaceSlug || !assignedSlugs.has(w.slug),
          )
          return (
            <div key={location} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label
                htmlFor={`ws-select-${location}`}
                style={{ width: 160, flexShrink: 0, fontSize: 19, color: '#e8d5a3', textShadow: realmTextShadow }}
              >
                {REALM_LOCATION_LABELS[location]}
              </label>
              <select
                id={`ws-select-${location}`}
                value={workspaceSlug ?? ''}
                onChange={(e) => handleChange(location, e.target.value || null)}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a84c]"
                style={selectStyle}
              >
                <option value="">— Unassigned —</option>
                {available.map((w) => (
                  <option key={w.slug} value={w.slug}>{w.displayName}</option>
                ))}
              </select>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section: Appearance (with shortcut note)
// ---------------------------------------------------------------------------

function AppearanceSection(): React.ReactElement {
  return (
    <div style={sectionContentStyle}>
      <div style={{ ...classicSettingsChrome, ...realmTokenOverrides }}>
        <AppearanceSettings />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toggle switch
// ---------------------------------------------------------------------------

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      style={{
        width: 48,
        height: 26,
        borderRadius: 13,
        background: checked ? '#c9a84c' : 'rgba(201,168,76,0.15)',
        border: '1px solid rgba(201,168,76,0.4)',
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 0.2s ease',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: checked ? '#1a1209' : '#6b5c44',
          transition: 'left 0.2s ease',
        }}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Scroll row wrapper
// ---------------------------------------------------------------------------

type ScrollState = 'active' | 'inactive' | 'disabled'

function scrollSrc(state: ScrollState): string {
  if (state === 'active') return scrollActive
  if (state === 'disabled') return scrollDisabled
  return scrollInactive
}

function ScrollRow({ label, description, children, state = 'active' }: {
  label: string
  description?: string
  children: React.ReactNode
  state?: ScrollState
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={settingLabelStyle}>{label}</div>
        {description && <div style={settingDescStyle}>{description}</div>}
      </div>
      <div
        style={{
          backgroundImage: `url(${scrollSrc(state)})`,
          backgroundSize: '100% 100%',
          backgroundRepeat: 'no-repeat',
          width: 250,
          height: 80,
          maxWidth: '40%',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          filter: state === 'active' ? 'drop-shadow(0 0 8px rgba(201,168,76,0.4))' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const realmTextShadow = '0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.5)'
const sectionContentStyle: React.CSSProperties = { padding: '4px 0', color: '#e8d5a3', fontSize: 19, textShadow: realmTextShadow }
const sectionLoadingStyle: React.CSSProperties = { color: '#9c8a6a', fontSize: 18, fontStyle: 'italic', textShadow: realmTextShadow }
const sectionHeadingStyle: React.CSSProperties = { color: '#c9a84c', fontSize: 23, margin: '0 0 16px 0', textShadow: realmTextShadow }
const settingLabelStyle: React.CSSProperties = { fontSize: 19, color: '#f5edd4', marginBottom: 2, fontWeight: 'bold', textShadow: realmTextShadow }
const settingDescStyle: React.CSSProperties = { fontSize: 16, color: '#c9b88e', margin: 0, textShadow: realmTextShadow }
const classicSettingsChrome: React.CSSProperties = {
  background: 'rgba(10,6,2,0.7)',
  border: '1px solid rgba(201,168,76,0.3)',
  borderRadius: 6,
  padding: '12px 16px',
  color: '#e8d5a3',
  fontFamily: 'serif',
  textShadow: realmTextShadow,
}
const realmTokenOverrides: Record<string, string> & React.CSSProperties = {
  // Base tokens (used by inline styles and as var() indirection source)
  '--co-bg-secondary': 'rgba(20,14,6,0.6)',
  '--co-bg-tertiary': 'rgba(30,20,8,0.7)',
  '--co-bg-elevated': 'rgba(25,18,7,0.8)',
  '--co-text-primary': '#f5edd4',
  '--co-text-secondary': '#c9b88e',
  '--co-text-muted': '#9c8a6a',
  '--co-border': 'rgba(201,168,76,0.25)',
  '--co-border-glow': 'rgba(201,168,76,0.35)',
  '--co-accent': '#c9a84c',
  '--co-accent-dim': '#a8893d',
  '--co-accent-glow': 'rgba(201,168,76,0.15)',
  // Tailwind 4 utilities reference --color-co-* directly; set them so
  // bg-co-accent, text-co-text-primary, etc. resolve to gold theme
  '--color-co-bg-secondary': 'rgba(20,14,6,0.6)',
  '--color-co-bg-tertiary': 'rgba(30,20,8,0.7)',
  '--color-co-bg-elevated': 'rgba(25,18,7,0.8)',
  '--color-co-text-primary': '#f5edd4',
  '--color-co-text-secondary': '#c9b88e',
  '--color-co-text-muted': '#9c8a6a',
  '--color-co-border': 'rgba(201,168,76,0.25)',
  '--color-co-border-glow': 'rgba(201,168,76,0.35)',
  '--color-co-accent': '#c9a84c',
  '--color-co-accent-dim': '#a8893d',
  '--color-co-accent-violet': '#c9a84c',
  '--color-co-accent-violet-dim': '#a8893d',
} as Record<string, string> & React.CSSProperties
const selectStyle: React.CSSProperties = {
  flex: 1,
  background: 'rgba(10,6,2,0.7)',
  border: '1px solid rgba(201,168,76,0.35)',
  borderRadius: 4,
  color: '#e8d5a3',
  fontSize: 18,
  padding: '5px 8px',
  cursor: 'pointer',
  textShadow: realmTextShadow,
}

// ---------------------------------------------------------------------------
// SettingsChamber
// ---------------------------------------------------------------------------

export function SettingsChamber({ initialSection = 'kingdom' }: { initialSection?: SettingsSectionId }): React.ReactElement {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  function handleTabKeyDown(e: React.KeyboardEvent, section: SettingsSectionId): void {
    const idx = SECTIONS.indexOf(section)
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSection(SECTIONS[(idx + 1) % SECTIONS.length])
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSection(SECTIONS[(idx - 1 + SECTIONS.length) % SECTIONS.length])
    }
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      style={{ position: 'relative', width: 1920, height: 1080, maxWidth: '95%', maxHeight: '95%', borderRadius: 8, overflow: 'hidden', fontFamily: 'serif', color: '#e8d5a3', outline: 'none' }}
      role="dialog"
      aria-modal="true"
      aria-label="Settings Chamber"
    >
      {/* Background */}
      <img
        src={settingsBg}
        alt=""
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: 'rgba(10,6,2,0.55)', pointerEvents: 'none' }}
      />

      {/* Content — inset to sit inside the ornate border frame */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%', padding: '60px 70px 60px 70px', boxSizing: 'border-box' }}>

        {/* Tab strip */}
        <div
          role="tablist"
          aria-label="Settings sections"
          style={{ display: 'flex', gap: 4, flexShrink: 0, marginBottom: 8 }}
        >
          {SECTIONS.map((section) => {
            const isActive = activeSection === section
            return (
              <button
                key={section}
                role="tab"
                aria-selected={isActive}
                aria-controls={`settings-panel-${section}`}
                id={`settings-tab-${section}`}
                onClick={() => setActiveSection(section)}
                onKeyDown={(e) => handleTabKeyDown(e, section)}
                tabIndex={isActive ? 0 : -1}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a84c] focus-visible:ring-offset-1"
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                <img
                  src={isActive ? SECTION_ACTIVE_ASSETS[section] : SECTION_INACTIVE_ASSETS[section]}
                  alt={SECTION_LABELS[section]}
                  style={{ width: 100, height: 145, objectFit: 'contain', display: 'block', maxWidth: '100%' }}
                />
              </button>
            )
          })}
        </div>

        {/* Panel */}
        <div
          role="tabpanel"
          id={`settings-panel-${activeSection}`}
          aria-labelledby={`settings-tab-${activeSection}`}
          style={{
            flex: 1,
            padding: '14px 16px',
            background: 'rgba(10,6,2,0.50)',
            border: '1px solid rgba(201,168,76,0.25)',
            borderRadius: 8,
            overflowY: 'auto',
          }}
        >
          {activeSection === 'kingdom' && <KingdomSection />}
          {activeSection === 'workspaces' && <WorkspacesSection />}
          {activeSection === 'hooks' && <div style={{ ...classicSettingsChrome, ...realmTokenOverrides }}><HookSettings /></div>}
          {activeSection === 'notifications' && <div style={{ ...classicSettingsChrome, ...realmTokenOverrides }}><NotificationSettings /></div>}
          {activeSection === 'appearance' && <AppearanceSection />}
        </div>
      </div>
    </div>
  )
}
