import React from 'react'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { friendlyDocError } from '../../utils/doc-errors'
import { BreadcrumbNav } from './BreadcrumbNav'
import { KeyDocumentsSection } from './KeyDocumentsSection'
import { FileTreeList } from './FileTreeList'

export function FolderBrowser(): React.ReactElement {
  const tree = useDocViewerStore((s) => s.tree)
  const breadcrumbs = useDocViewerStore((s) => s.breadcrumbs)
  const treeLoading = useDocViewerStore((s) => s.treeLoading)
  const error = useDocViewerStore((s) => s.error)
  const retry = useDocViewerStore((s) => s.retry)

  if (treeLoading) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        <div className="h-4 bg-co-bg-tertiary rounded w-1/2" />
        <div className="h-8 bg-co-bg-tertiary rounded w-full" />
        <div className="h-8 bg-co-bg-tertiary rounded w-full" />
        <div className="h-8 bg-co-bg-tertiary rounded w-full" />
        <div className="h-8 bg-co-bg-tertiary rounded w-2/3" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="text-co-status-attention text-sm">{friendlyDocError(error)}</div>
        <button
          onClick={retry}
          className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent rounded-lg hover:bg-co-accent/20 transition-colors"
        >
          Try again
        </button>
      </div>
    )
  }

  if (!tree) return <></>

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb navigation */}
      {breadcrumbs.length > 0 && (
        <div className="mb-4">
          <BreadcrumbNav />
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-4">
        {/* Key documents pinned at top */}
        <KeyDocumentsSection entries={tree.entries} />

        {/* Directory tree */}
        <FileTreeList entries={tree.entries} />
      </div>
    </div>
  )
}
