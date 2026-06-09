import React from 'react'
import { useDocViewerStore } from '../../stores/docviewer-store'

function humanizeTeamArtifactName(name: string): string {
  // Keep NN prefix for spawn order, strip leading dot (e.g. ".02-impl-team" → "02 impl team")
  const stripped = name.replace(/^\.(\d{2}-)/, '$1')
  // Replace hyphens with spaces, title-case
  return stripped
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function isTeamArtifactName(name: string): boolean {
  return /^\.\d{2}-/.test(name)
}

export function BreadcrumbNav(): React.ReactElement {
  const breadcrumbs = useDocViewerStore((s) => s.breadcrumbs)
  const navigateToDir = useDocViewerStore((s) => s.navigateToDir)

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm flex-wrap">
      {breadcrumbs.map((crumb, i) => {
        const isLast = i === breadcrumbs.length - 1
        const displayLabel = isTeamArtifactName(crumb.label)
          ? humanizeTeamArtifactName(crumb.label)
          : crumb.label

        return (
          <React.Fragment key={crumb.path}>
            {i > 0 && (
              <span className="text-co-text-muted mx-0.5">/</span>
            )}
            {isLast ? (
              <span className="text-co-text-primary font-medium">{displayLabel}</span>
            ) : (
              <button
                type="button"
                onClick={() => navigateToDir(crumb.path)}
                className="text-co-text-secondary hover:text-co-accent underline decoration-co-text-muted/30 underline-offset-2 cursor-pointer transition-colors"
              >
                {displayLabel}
              </button>
            )}
          </React.Fragment>
        )
      })}
    </nav>
  )
}
