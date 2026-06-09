import React, { useEffect, useRef, useState } from 'react'
import type { Instinct, EvolvedArtifact, EvolvedType } from '@main/types/homunculus'
import { useHomunculusStore } from '../../../stores/homunculus-store'
import { RealmAsset } from '../shared/RealmAsset'
import type { RealmAssetId } from '../shared/RealmAsset'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function instinctGemAsset(confidence: number): RealmAssetId {
  if (confidence >= 0.8) return 'homunculus:instinct_high'
  if (confidence >= 0.5) return 'homunculus:instinct_medium'
  return 'homunculus:instinct_low'
}

function medallionAsset(type: EvolvedType): RealmAssetId {
  if (type === 'agent') return 'homunculus:medallion_agent'
  if (type === 'skill') return 'homunculus:medallion_skill'
  return 'homunculus:medallion_command'
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return 'High'
  if (confidence >= 0.5) return 'Medium'
  return 'Low'
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InstinctRow({ instinct }: { instinct: Instinct }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className="flex items-start gap-3 py-2 border-b"
      style={{ borderColor: 'rgba(201,168,76,0.15)', cursor: 'pointer', background: expanded ? 'rgba(201,168,76,0.03)' : 'transparent' }}
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
    >
      <RealmAsset
        id={instinctGemAsset(instinct.confidence)}
        alt={`${confidenceLabel(instinct.confidence)} confidence`}
        style={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0, marginTop: 2 }}
      />
      <div className="flex-1 min-w-0">
        <p className="leading-snug" style={{ color: '#e8d5a3', fontSize: 15 }}>
          {expanded
            ? instinct.trigger
            : instinct.trigger.length > 80
              ? instinct.trigger.slice(0, 77) + '…'
              : instinct.trigger}
        </p>
        <p className="mt-0.5" style={{ color: '#9c8a6a', fontSize: 13 }}>
          {instinct.domain}
          {instinct.type === 'inherited' && (
            <span style={{ color: '#c9a84c', marginLeft: 6 }}>inherited</span>
          )}
        </p>
        {expanded && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            <p style={{ color: '#9c8a6a', fontSize: 13 }}>
              Type: {instinct.type} · Domain: {instinct.domain}
            </p>
            <p style={{ color: '#9c8a6a', fontSize: 13 }}>
              Modified: {new Date(instinct.lastModified).toLocaleDateString()}
            </p>
          </div>
        )}
      </div>
      <span className="shrink-0 mt-1" style={{ color: '#c9a84c', fontSize: 14 }}>
        {Math.round(instinct.confidence * 100)}%
      </span>
    </div>
  )
}

function EvolvedRow({ artifact }: { artifact: EvolvedArtifact }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={`flex ${expanded ? 'items-start' : 'items-center'} gap-3 py-2 border-b`}
      style={{ borderColor: 'rgba(201,168,76,0.15)', cursor: 'pointer', background: expanded ? 'rgba(201,168,76,0.03)' : 'transparent' }}
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
    >
      <RealmAsset
        id={medallionAsset(artifact.type)}
        alt={artifact.type}
        style={{ width: 44, height: 44, objectFit: 'contain', flexShrink: 0 }}
      />
      <div className="flex-1 min-w-0">
        <p style={{ color: '#e8d5a3', fontSize: 15 }}>{artifact.name}</p>
        <p className="capitalize" style={{ color: '#9c8a6a', fontSize: 13 }}>{artifact.type}</p>
        {expanded && (
          <div className="mt-1 flex flex-col gap-0.5">
            <p className="font-mono" style={{ color: '#9c8a6a', fontSize: 13, wordBreak: 'break-all' }}>
              {artifact.filePath}
            </p>
            <p style={{ color: '#9c8a6a', fontSize: 13 }}>
              Modified: {new Date(artifact.lastModified).toLocaleDateString()}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TowerView
// ---------------------------------------------------------------------------

export function TowerView(): React.ReactElement {
  const { state, loading, error, fetchState, initListeners } = useHomunculusStore()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    void fetchState()
    // initListeners is a stable store action — safe in effect deps
    const cleanup = initListeners()
    return cleanup
  }, [fetchState, initListeners])

  // Esc key handled by RealmShell — no additional handler needed here

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="relative w-[1920px] h-[1080px] max-w-[95%] max-h-[95%] rounded-lg flex flex-col overflow-hidden"
      style={{
        background: '#1e140a',
        border: '2px solid rgba(201,168,76,0.5)',
        fontFamily: 'serif',
        outline: 'none',
      }}
      role="dialog"
      aria-modal="true"
      aria-label="The Tower — Homunculus Instincts"
    >
      {/* Background image */}
      <RealmAsset
        id="homunculus:background"
        alt=""
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 0.35,
          pointerEvents: 'none',
        }}
      />
      {/* Readability overlay */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: 'rgba(10,6,2,0.50)', pointerEvents: 'none' }}
      />

      {/* Header */}
      <div
        className="relative z-10 flex items-center px-6 py-4 shrink-0"
        style={{ borderBottom: '1px solid rgba(201,168,76,0.3)' }}
      >
        <div>
          <h2 className="text-2xl font-medium" style={{ color: '#c9a84c' }}>
            The Tower
          </h2>
          <p style={{ color: '#9c8a6a', fontSize: 14 }}>Homunculus Instincts</p>
        </div>
      </div>

      {/* Body */}
      <div className="relative z-10 flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-6">
        {error && (
          <div
            className="text-center py-8"
            style={{ color: '#e05c5c', fontSize: 16 }}
            role="alert"
          >
            The Homunculus cannot be reached.
            <p className="mt-1" style={{ color: '#9c8a6a', fontSize: 14 }}>{error}</p>
          </div>
        )}

        {loading && !state && !error && (
          <p className="text-center py-8" style={{ color: '#9c8a6a', fontSize: 16 }}>
            The Homunculus stirs…
          </p>
        )}

        {state && (
          <div
            style={{
              background: 'rgba(10,6,2,0.60)',
              border: '1px solid rgba(201,168,76,0.3)',
              borderRadius: 8,
              padding: '16px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
            }}
          >
            {/* Stats row */}
            <div className="flex gap-6" style={{ color: '#9c8a6a', fontSize: 15 }}>
              <span><strong style={{ color: '#c9a84c' }}>{state.stats.totalInstincts}</strong> instincts</span>
              <span><strong style={{ color: '#c9a84c' }}>{state.evolved.length}</strong> evolved</span>
              <span>
                <strong style={{ color: '#c9a84c' }}>{state.stats.confidenceDistribution.high}</strong> high /&nbsp;
                <strong style={{ color: '#c9a84c' }}>{state.stats.confidenceDistribution.medium}</strong> med /&nbsp;
                <strong style={{ color: '#c9a84c' }}>{state.stats.confidenceDistribution.low}</strong> low
              </span>
            </div>

            {/* Instincts */}
            <section>
              <h3 className="font-medium mb-2" style={{ color: '#c9a84c', fontSize: 16 }}>
                Instincts
              </h3>
              {state.instincts.length === 0 ? (
                <p style={{ color: '#9c8a6a', fontSize: 15 }}>No instincts recorded yet.</p>
              ) : (
                <div>
                  {state.instincts.slice(0, 20).map((inst) => (
                    <InstinctRow key={inst.id} instinct={inst} />
                  ))}
                  {state.instincts.length > 20 && (
                    <p className="pt-2" style={{ color: '#9c8a6a', fontSize: 13 }}>
                      +{state.instincts.length - 20} more
                    </p>
                  )}
                </div>
              )}
            </section>

            {/* Cross-workspace patterns */}
            {state.stats.crossWorkspacePatterns.length > 0 && (
              <section>
                <h3 className="font-medium mb-2" style={{ color: '#c9a84c', fontSize: 16 }}>
                  Cross-Workspace Patterns
                </h3>
                {state.stats.crossWorkspacePatterns.slice(0, 5).map((pattern) => {
                  const slugs = pattern.workspacesApplied
                  const displayed = slugs.slice(0, 3).join(', ')
                  const extra = slugs.length > 3 ? ` +${slugs.length - 3} more` : ''
                  return (
                    <div
                      key={pattern.instinctId}
                      className="py-2 border-b"
                      style={{ borderColor: 'rgba(201,168,76,0.15)' }}
                    >
                      <p style={{ color: '#e8d5a3', fontSize: 14 }}>
                        {pattern.domain} — {displayed}{extra}
                      </p>
                      <p style={{ color: '#9c8a6a', fontSize: 13 }}>
                        Confidence: {Math.round(pattern.confidence * 100)}%
                      </p>
                    </div>
                  )
                })}
              </section>
            )}

            {/* Evolved artifacts */}
            {state.evolved.length > 0 && (
              <section>
                <h3 className="font-medium mb-2" style={{ color: '#c9a84c', fontSize: 16 }}>
                  Evolved Artifacts
                </h3>
                {state.evolved.map((artifact) => (
                  <EvolvedRow key={artifact.filePath} artifact={artifact} />
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
