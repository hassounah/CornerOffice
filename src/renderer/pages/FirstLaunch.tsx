import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { WorkspaceDiscoveryResult } from '@main/types/workspace'
import { useSettingsStore } from '../stores/settings-store'
import { unwrapIpc } from '../utils/ipc'
import type { IpcResponse } from '../utils/ipc'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WizardState {
  step: 1 | 2 | 3 | 4
  discovered: WorkspaceDiscoveryResult[]
  selectedSlugs: Set<string>
  companyName: string
}

// ---------------------------------------------------------------------------
// ProgressDots (steps 1–4)
// ---------------------------------------------------------------------------

function ProgressDots({ current, total }: { current: number; total: number }): React.ReactElement {
  return (
    <div className="flex items-center justify-center gap-2" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={[
            'h-1.5 rounded-full transition-all duration-300',
            i + 1 === current
              ? 'w-4 bg-co-accent'
              : i + 1 < current
                ? 'w-1.5 bg-co-accent/50'
                : 'w-1.5 bg-co-border',
          ].join(' ')}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1: Welcome
// ---------------------------------------------------------------------------

function StepWelcome({ onNext }: { onNext: () => void }): React.ReactElement {
  return (
    <div className="flex flex-col items-center text-center gap-6">
      <span className="text-6xl" aria-hidden="true">🏢</span>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-co-text-primary">Welcome to Corner Office</h1>
        <p className="text-co-text-muted text-sm max-w-sm">
          Your AI dev team command center. Track pipelines, celebrate ships, and watch your
          team's intelligence grow — all from one place.
        </p>
      </div>
      <button
        onClick={onNext}
        className="px-6 py-2 rounded-lg bg-co-accent text-white text-sm font-medium hover:bg-co-accent/90 transition-colors"
      >
        Get started
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2: Workspace Discovery
// ---------------------------------------------------------------------------

function StepWorkspaces({
  discovered,
  selectedSlugs,
  onToggle,
  onNext,
  onBack,
}: {
  discovered: WorkspaceDiscoveryResult[]
  selectedSlugs: Set<string>
  onToggle: (slug: string) => void
  onNext: () => void
  onBack: () => void
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-5 w-full max-w-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-co-text-primary">Your Workspaces</h2>
        <p className="text-xs text-co-text-muted">
          We found these Rix workspaces on your machine.
        </p>
      </div>

      {discovered.length === 0 ? (
        <div className="rounded-lg border border-white/[0.04] bg-co-bg-elevated p-4 text-center flex flex-col gap-2">
          <p className="text-sm text-co-text-muted">No Rix workspaces found.</p>
          <p className="text-xs text-co-text-muted">
            Corner Office reads workspaces with a <code className="font-mono text-co-text-secondary">.rix/</code> directory.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2 max-h-48 overflow-y-auto">
          {discovered.map((ws) => (
            <li key={ws.slug}>
              <label className="flex items-start gap-3 rounded-lg border border-white/[0.04] bg-co-bg-elevated p-3 cursor-pointer hover:border-co-accent/40 transition-colors">
                <input
                  type="checkbox"
                  checked={selectedSlugs.has(ws.slug)}
                  onChange={() => onToggle(ws.slug)}
                  className="mt-0.5 accent-co-accent"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-co-text-primary truncate">
                    {ws.slug}
                  </p>
                  <p className="text-xs text-co-text-muted truncate">{ws.path}</p>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-3 justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg border border-white/[0.04] text-sm text-co-text-secondary hover:border-co-accent/40 transition-colors"
        >
          Back
        </button>
        <button
          onClick={onNext}
          className="px-5 py-2 rounded-lg bg-co-accent text-white text-sm font-medium hover:bg-co-accent/90 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 3: Company Name
// ---------------------------------------------------------------------------

function StepCompanyName({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: string
  onChange: (name: string) => void
  onNext: () => void
  onBack: () => void
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && value.trim()) {
      onNext()
    }
  }

  return (
    <div className="flex flex-col gap-5 w-full max-w-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-co-text-primary">Name Your Company</h2>
        <p className="text-xs text-co-text-muted">
          Give your AI dev org an identity. This name appears across Corner Office.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="company-name" className="text-xs text-co-text-muted">
          Company name
        </label>
        <input
          id="company-name"
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Acme Labs, Studio 42, The Forge"
          className="w-full rounded-lg border border-white/[0.04] bg-co-bg-elevated px-3 py-2 text-sm text-co-text-primary placeholder-co-text-muted focus:outline-none focus:ring-1 focus:ring-co-accent"
        />
      </div>

      <div className="flex gap-3 justify-between">
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg border border-white/[0.04] text-sm text-co-text-secondary hover:border-co-accent/40 transition-colors"
        >
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!value.trim()}
          className="px-5 py-2 rounded-lg bg-co-accent text-white text-sm font-medium hover:bg-co-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Finish setup
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 5: The Reveal
// ---------------------------------------------------------------------------

function StepReveal({ companyName }: { companyName: string }): React.ReactElement {
  return (
    <div
      className="flex flex-col items-center text-center gap-6 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700"
      aria-live="polite"
    >
      <span className="text-6xl" aria-hidden="true">🚀</span>
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold text-co-text-primary">
          {companyName ? `${companyName} is ready.` : "You're all set."}
        </h2>
        <p className="text-co-text-muted text-sm">
          Taking you to your dashboard…
        </p>
      </div>
      <div className="h-1 w-1 rounded-full bg-co-accent animate-ping" aria-hidden="true" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// FirstLaunch wizard
// ---------------------------------------------------------------------------

export default function FirstLaunch(): React.ReactElement {
  const navigate = useNavigate()
  const { updateConfig, fetchConfig } = useSettingsStore()

  const [wizard, setWizard] = useState<WizardState>({
    step: 1,
    discovered: [],
    selectedSlugs: new Set(),
    companyName: '',
  })

  // Discover workspaces when entering step 2
  const discoverWorkspaces = useCallback(async () => {
    try {
      const response = await window.cornerOffice.workspace.discover() as IpcResponse<WorkspaceDiscoveryResult[]>
      const found = unwrapIpc(response)
      setWizard((prev) => ({
        ...prev,
        discovered: found,
        selectedSlugs: new Set(found.map((w) => w.slug)),
      }))
    } catch {
      // Discovery failure is non-fatal — continue with empty list
      setWizard((prev) => ({ ...prev, discovered: [], selectedSlugs: new Set() }))
    }
  }, [])

  const goTo = useCallback((step: WizardState['step']) => {
    setWizard((prev) => ({ ...prev, step }))
  }, [])

  const handleNext1 = useCallback(() => {
    void discoverWorkspaces()
    goTo(2)
  }, [discoverWorkspaces, goTo])

  const handleNext2 = useCallback(() => {
    goTo(3)
  }, [goTo])

  const handleBack2 = useCallback(() => goTo(1), [goTo])

  const handleToggleSlug = useCallback((slug: string) => {
    setWizard((prev) => {
      const next = new Set(prev.selectedSlugs)
      if (next.has(slug)) {
        next.delete(slug)
      } else {
        next.add(slug)
      }
      return { ...prev, selectedSlugs: next }
    })
  }, [])

  const handleCompanyNameChange = useCallback((name: string) => {
    setWizard((prev) => ({ ...prev, companyName: name }))
  }, [])

  const handleBack3 = useCallback(() => goTo(2), [goTo])

  const handleFinish = useCallback(async () => {
    goTo(4)
    await updateConfig({
      companyName: wizard.companyName.trim(),
      firstLaunchComplete: true,
    })
    await fetchConfig()
    setTimeout(() => {
      void navigate('/')
    }, 1500)
  }, [wizard.companyName, updateConfig, fetchConfig, navigate, goTo])

  return (
    <div className="flex flex-col h-full items-center justify-center bg-co-bg-primary p-8">
      <div className="w-full max-w-sm flex flex-col items-center gap-8">

        {/* Step content */}
        <div className="w-full flex justify-center">
          {wizard.step === 1 && (
            <StepWelcome onNext={handleNext1} />
          )}
          {wizard.step === 2 && (
            <StepWorkspaces
              discovered={wizard.discovered}
              selectedSlugs={wizard.selectedSlugs}
              onToggle={handleToggleSlug}
              onNext={handleNext2}
              onBack={handleBack2}
            />
          )}
          {wizard.step === 3 && (
            <StepCompanyName
              value={wizard.companyName}
              onChange={handleCompanyNameChange}
              onNext={handleFinish}
              onBack={handleBack3}
            />
          )}
          {wizard.step === 4 && (
            <StepReveal companyName={wizard.companyName} />
          )}
        </div>

        {/* Progress dots — hidden on step 4 */}
        {wizard.step < 4 && (
          <ProgressDots current={wizard.step} total={3} />
        )}
      </div>
    </div>
  )
}
