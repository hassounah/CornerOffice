import React from 'react'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard'
import { YamlContent } from './YamlContent'

interface YamlViewerProps {
  content: string
}

export function YamlViewer({ content }: YamlViewerProps): React.ReactElement {
  const openedFromFolder = useDocViewerStore((s) => s.openedFromFolder)
  const navigateBack = useDocViewerStore((s) => s.navigateBack)
  // Guard: routes navigation through unsaved-changes check (§17 R9)
  const guard = useUnsavedGuard()

  return (
    <div>
      {/* Back button — guarded (§17 R9); shown above all three YamlContent branches */}
      {openedFromFolder && (
        <button
          onClick={() => guard(navigateBack)}
          className="flex items-center gap-1.5 text-sm text-co-text-secondary hover:text-co-accent transition-colors mb-4"
        >
          <span>←</span>
          <span>Back to folder</span>
        </button>
      )}
      <YamlContent content={content} />
    </div>
  )
}
