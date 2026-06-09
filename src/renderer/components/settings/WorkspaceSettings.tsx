import React, { useState } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import type { WorkspaceConfig } from '@main/types/config'

interface WorkspaceRowProps {
  wsConfig: WorkspaceConfig
  onUpdate: (patch: Partial<WorkspaceConfig>) => Promise<void>
}

function WorkspaceRow({ wsConfig, onUpdate }: WorkspaceRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [displayName, setDisplayName] = useState(wsConfig.displayName ?? '')
  const [docsRoot, setDocsRoot] = useState(wsConfig.docsRoot ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [docsError, setDocsError] = useState<string | null>(null)

  async function saveDisplayName(): Promise<void> {
    setNameError(null)
    try {
      await onUpdate({ displayName: displayName.trim() || null })
    } catch (e) {
      setNameError(e instanceof Error ? e.message : String(e))
    }
  }

  async function saveDocsRoot(): Promise<void> {
    setDocsError(null)
    try {
      await onUpdate({ docsRoot: docsRoot.trim() || null })
    } catch (e) {
      setDocsError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className={[
      'rounded-lg border transition-colors',
      wsConfig.archived ? 'border-white/[0.04] opacity-60' : 'border-white/[0.04]',
    ].join(' ')}>
      {/* Row header */}
      <div className="flex items-center gap-3 p-3 bg-co-bg-elevated rounded-lg">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((p) => !p)}
          className="text-co-text-muted hover:text-co-text-secondary transition-colors shrink-0"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${wsConfig.slug}`}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-co-text-primary truncate">
            {wsConfig.displayName ?? wsConfig.slug}
          </p>
          <p className="text-xs text-co-text-muted truncate">{wsConfig.path}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Pin toggle */}
          <button
            type="button"
            aria-label={wsConfig.pinned ? `Unpin ${wsConfig.slug}` : `Pin ${wsConfig.slug}`}
            aria-pressed={wsConfig.pinned}
            onClick={() => void onUpdate({ pinned: !wsConfig.pinned })}
            className={[
              'text-xs px-2 py-0.5 rounded border transition-colors',
              wsConfig.pinned
                ? 'bg-co-accent/20 border-co-accent text-co-accent'
                : 'bg-co-bg-tertiary border-white/[0.04] text-co-text-muted hover:text-co-text-secondary',
            ].join(' ')}
          >
            Pin
          </button>

          {/* Archive toggle */}
          <button
            type="button"
            aria-label={wsConfig.archived ? `Unarchive ${wsConfig.slug}` : `Archive ${wsConfig.slug}`}
            aria-pressed={wsConfig.archived}
            onClick={() => void onUpdate({ archived: !wsConfig.archived })}
            className={[
              'text-xs px-2 py-0.5 rounded border transition-colors',
              wsConfig.archived
                ? 'bg-yellow-900/20 border-yellow-700 text-yellow-400'
                : 'bg-co-bg-tertiary border-white/[0.04] text-co-text-muted hover:text-co-text-secondary',
            ].join(' ')}
          >
            {wsConfig.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </div>

      {/* Expanded section */}
      {expanded && (
        <div className="p-3 border-t border-white/[0.04] flex flex-col gap-4 bg-co-bg-primary rounded-b-lg">
          {/* Display name */}
          <div>
            <label
              htmlFor={`display-name-${wsConfig.slug}`}
              className="block text-xs text-co-text-secondary mb-1"
            >
              Display Name
            </label>
            <input
              id={`display-name-${wsConfig.slug}`}
              type="text"
              value={displayName}
              placeholder={wsConfig.slug}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={() => void saveDisplayName()}
              className={[
                'w-full max-w-xs px-3 py-1.5 rounded bg-co-bg-tertiary border text-sm text-co-text-primary',
                'focus:outline-none focus:border-co-accent placeholder:text-co-text-muted',
                nameError ? 'border-red-500' : 'border-white/[0.04]',
              ].join(' ')}
            />
            {nameError && (
              <p className="text-xs text-red-400 mt-1" role="alert">{nameError}</p>
            )}
          </div>

          {/* Docs root */}
          <div>
            <label
              htmlFor={`docs-root-${wsConfig.slug}`}
              className="block text-xs text-co-text-secondary mb-1"
            >
              Docs Root Override
            </label>
            <input
              id={`docs-root-${wsConfig.slug}`}
              type="text"
              value={docsRoot}
              placeholder="Auto-detected from memory.md"
              onChange={(e) => setDocsRoot(e.target.value)}
              onBlur={() => void saveDocsRoot()}
              className={[
                'w-full max-w-sm px-3 py-1.5 rounded bg-co-bg-tertiary border text-sm text-co-text-primary',
                'focus:outline-none focus:border-co-accent placeholder:text-co-text-muted font-mono text-xs',
                docsError ? 'border-red-500' : 'border-white/[0.04]',
              ].join(' ')}
            />
            {docsError && (
              <p className="text-xs text-red-400 mt-1" role="alert">{docsError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function WorkspaceSettings(): React.ReactElement {
  const config = useSettingsStore((s) => s.config)
  const updateConfig = useSettingsStore((s) => s.updateConfig)
  const fetchAll = useWorkspaceStore((s) => s.fetchAll)

  const [exclusionInput, setExclusionInput] = useState('')
  const [reDiscovering, setReDiscovering] = useState(false)
  const [reDiscoverError, setReDiscoverError] = useState<string | null>(null)

  if (!config) return <div className="text-co-text-muted text-sm">Loading…</div>

  const { workspaces, discoveryExclusions } = config

  async function updateWorkspace(slug: string, patch: Partial<WorkspaceConfig>): Promise<void> {
    const updated = workspaces.map((ws) =>
      ws.slug === slug ? { ...ws, ...patch } : ws,
    )
    await updateConfig({ workspaces: updated })
  }

  async function handleReDiscover(): Promise<void> {
    setReDiscovering(true)
    setReDiscoverError(null)
    try {
      await fetchAll()
    } catch (e) {
      setReDiscoverError(e instanceof Error ? e.message : String(e))
    } finally {
      setReDiscovering(false)
    }
  }

  async function addExclusion(): Promise<void> {
    const val = exclusionInput.trim()
    if (!val || discoveryExclusions.includes(val)) {
      setExclusionInput('')
      return
    }
    await updateConfig({ discoveryExclusions: [...discoveryExclusions, val] })
    setExclusionInput('')
  }

  async function removeExclusion(pattern: string): Promise<void> {
    await updateConfig({
      discoveryExclusions: discoveryExclusions.filter((p) => p !== pattern),
    })
  }

  const pinned = workspaces.filter((ws) => ws.pinned)
  const regular = workspaces.filter((ws) => !ws.pinned && !ws.archived)
  const archived = workspaces.filter((ws) => ws.archived)

  return (
    <div className="flex flex-col gap-8">
      {/* Re-discover */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-co-text-primary">Discovered Workspaces</h3>
            <p className="text-xs text-co-text-muted mt-0.5">{workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''} found</p>
          </div>
          <button
            type="button"
            onClick={() => void handleReDiscover()}
            disabled={reDiscovering}
            aria-busy={reDiscovering}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-co-bg-tertiary border border-white/[0.04] text-co-text-secondary hover:text-co-text-primary disabled:opacity-50 transition-colors"
          >
            {reDiscovering ? 'Scanning…' : 'Re-discover'}
          </button>
        </div>

        {reDiscoverError && (
          <p className="text-xs text-red-400 mb-3" role="alert">{reDiscoverError}</p>
        )}

        {workspaces.length === 0 ? (
          <p className="text-sm text-co-text-muted">No workspaces discovered yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {pinned.length > 0 && (
              <div>
                <p className="text-xs font-medium text-co-text-muted uppercase tracking-wider mb-1.5">Pinned</p>
                <div className="flex flex-col gap-1.5">
                  {pinned.map((ws) => (
                    <WorkspaceRow
                      key={ws.slug}
                      wsConfig={ws}
                      onUpdate={(patch) => updateWorkspace(ws.slug, patch)}
                    />
                  ))}
                </div>
              </div>
            )}

            {regular.length > 0 && (
              <div>
                {pinned.length > 0 && (
                  <p className="text-xs font-medium text-co-text-muted uppercase tracking-wider mb-1.5 mt-3">Workspaces</p>
                )}
                <div className="flex flex-col gap-1.5">
                  {regular.map((ws) => (
                    <WorkspaceRow
                      key={ws.slug}
                      wsConfig={ws}
                      onUpdate={(patch) => updateWorkspace(ws.slug, patch)}
                    />
                  ))}
                </div>
              </div>
            )}

            {archived.length > 0 && (
              <div>
                <p className="text-xs font-medium text-co-text-muted uppercase tracking-wider mb-1.5 mt-3">Archived</p>
                <div className="flex flex-col gap-1.5">
                  {archived.map((ws) => (
                    <WorkspaceRow
                      key={ws.slug}
                      wsConfig={ws}
                      onUpdate={(patch) => updateWorkspace(ws.slug, patch)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Exclusion patterns */}
      <section>
        <h3 className="text-sm font-semibold text-co-text-primary mb-1">Exclusion Patterns</h3>
        <p className="text-xs text-co-text-muted mb-3">
          Directory names to skip during workspace discovery (e.g. node_modules, .git).
        </p>

        <div className="flex gap-2 mb-3 max-w-sm">
          <input
            type="text"
            value={exclusionInput}
            onChange={(e) => setExclusionInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addExclusion() }}
            placeholder="Add pattern…"
            aria-label="Exclusion pattern"
            className="flex-1 px-3 py-1.5 rounded bg-co-bg-tertiary border border-white/[0.04] text-sm text-co-text-primary focus:outline-none focus:border-co-accent placeholder:text-co-text-muted"
          />
          <button
            type="button"
            onClick={() => void addExclusion()}
            className="px-3 py-1.5 rounded bg-co-bg-tertiary border border-white/[0.04] text-sm text-co-text-secondary hover:text-co-text-primary transition-colors"
          >
            Add
          </button>
        </div>

        {discoveryExclusions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {discoveryExclusions.map((pattern) => (
              <span
                key={pattern}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-co-bg-tertiary border border-white/[0.04] text-co-text-secondary"
              >
                {pattern}
                <button
                  type="button"
                  aria-label={`Remove exclusion ${pattern}`}
                  onClick={() => void removeExclusion(pattern)}
                  className="text-co-text-muted hover:text-co-text-secondary transition-colors"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
