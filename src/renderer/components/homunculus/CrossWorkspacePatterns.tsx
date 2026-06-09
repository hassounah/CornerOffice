import React from 'react'
import type { CrossWorkspacePattern, Instinct } from '@main/types/homunculus'

interface CrossWorkspacePatternsProps {
  patterns: CrossWorkspacePattern[]
  instincts: Instinct[]
}

export function CrossWorkspacePatterns({ patterns, instincts }: CrossWorkspacePatternsProps): React.ReactElement | null {
  if (patterns.length === 0) return null

  // Group patterns by domain
  const byDomain = new Map<string, CrossWorkspacePattern[]>()
  for (const p of patterns) {
    const list = byDomain.get(p.domain) ?? []
    list.push(p)
    byDomain.set(p.domain, list)
  }

  // Build a lookup for instinct trigger by id
  const triggerById = new Map(instincts.map((i) => [i.id, i.trigger]))

  return (
    <section aria-label="Cross-workspace patterns" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-co-text-primary">Cross-Workspace Patterns</h2>
      {Array.from(byDomain.entries()).map(([domain, domainPatterns]) => (
        <div key={domain} className="rounded-lg border border-white/[0.04] bg-co-bg-elevated p-4 flex flex-col gap-2">
          {/* Domain header */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-co-accent/20 text-co-accent font-medium">
              {domain}
            </span>
            <span className="text-xs text-co-text-muted">{domainPatterns.length} pattern{domainPatterns.length !== 1 ? 's' : ''}</span>
          </div>

          {/* Pattern list */}
          <ul className="flex flex-col gap-2">
            {domainPatterns.map((p) => (
              <li key={p.instinctId} className="flex flex-col gap-1">
                <p className="text-xs text-co-text-secondary">
                  {triggerById.get(p.instinctId) ?? p.instinctId}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {p.workspacesApplied.map((ws) => (
                    <span key={ws} className="text-[10px] px-1.5 py-0.5 rounded bg-co-bg-tertiary text-co-text-muted">
                      {ws}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
