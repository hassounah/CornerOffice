import React from 'react'
import type { Feature, IdeationItem } from '@main/types/workspace'
import { FeatureCard } from './FeatureCard'
import { IdeationCard } from './IdeationCard'
import { useSettingsStore } from '../../stores/settings-store'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { DocViewerOverlay } from '../docviewer'

interface FeatureBoardProps {
  features: Feature[]
  ideationItems: IdeationItem[]
  workspaceSlug?: string
}

interface Column {
  id: string
  label: string
  accent?: string
  items: React.ReactNode[]
}

export function FeatureBoard({ features, ideationItems, workspaceSlug }: FeatureBoardProps): React.ReactElement {
  const compactView = useSettingsStore((s) => s.config?.appearance.compactView ?? false)
  const openFolder = useDocViewerStore((s) => s.openFolder)
  const openFile = useDocViewerStore((s) => s.openFile)

  const handleFeatureClick = (feature: Feature) => {
    if (workspaceSlug) {
      openFolder(feature.directory, workspaceSlug)
    }
  }

  const handleIdeationClick = (item: IdeationItem) => {
    if (workspaceSlug) {
      openFile(item.path, workspaceSlug)
    }
  }

  const todoFeatures = features.filter((f) => f.status === 'todo')
  const inProgressFeatures = features.filter((f) => f.status === 'in_progress')
  const doneFeatures = features.filter((f) => f.status === 'done')

  const columns: Column[] = [
    {
      id: 'ideation',
      label: 'Ideation',
      accent: 'bg-co-accent/60',
      items: ideationItems.map((item) => (
        <IdeationCard key={item.filename} item={item} onClick={workspaceSlug ? handleIdeationClick : undefined} />
      )),
    },
    {
      id: 'todo',
      label: 'TODO',
      accent: 'bg-amber-400/60',
      items: todoFeatures.map((f) => (
        <FeatureCard key={f.slug} feature={f} onClick={workspaceSlug ? handleFeatureClick : undefined} />
      )),
    },
    {
      id: 'in_progress',
      label: 'In Progress',
      accent: 'bg-co-accent-teal/60',
      items: inProgressFeatures.map((f) => (
        <FeatureCard key={f.slug} feature={f} onClick={workspaceSlug ? handleFeatureClick : undefined} />
      )),
    },
    {
      id: 'done',
      label: 'Done',
      accent: 'bg-emerald-400/60',
      items: doneFeatures.map((f) => (
        <FeatureCard key={f.slug} feature={f} onClick={workspaceSlug ? handleFeatureClick : undefined} />
      )),
    },
  ]

  return (
    <section aria-label="Feature board">
      <div className={`grid grid-cols-4 ${compactView ? 'gap-2' : 'gap-3'}`}>
        {columns.map((col) => (
          <div key={col.id} className={`flex flex-col ${compactView ? 'gap-1.5' : 'gap-2'}`}>
            {/* Column header with accent bar */}
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-1 h-3 rounded-full ${col.accent}`} />
              <h3 className="text-[11px] font-semibold text-co-text-muted uppercase tracking-widest">
                {col.label}
              </h3>
              {col.items.length > 0 && (
                <span className="text-[10px] font-medium text-co-text-muted/60 tabular-nums">
                  {col.items.length}
                </span>
              )}
            </div>

            {/* Cards */}
            {col.items.length === 0 ? (
              <div className={`${compactView ? 'h-8' : 'h-12'}`} />
            ) : (
              <div className={compactView ? 'flex flex-col gap-1.5' : 'flex flex-col gap-2'}>{col.items}</div>
            )}
          </div>
        ))}
      </div>
      <DocViewerOverlay />
    </section>
  )
}
