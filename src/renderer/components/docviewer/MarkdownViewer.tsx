import React from 'react'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard'
import { friendlyDocError } from '../../utils/doc-errors'
import { MarkdownContent } from './MarkdownContent'

export function MarkdownViewer(): React.ReactElement {
  const file = useDocViewerStore((s) => s.file)
  const fileLoading = useDocViewerStore((s) => s.fileLoading)
  const error = useDocViewerStore((s) => s.error)
  const openedFromFolder = useDocViewerStore((s) => s.openedFromFolder)
  const navigateBack = useDocViewerStore((s) => s.navigateBack)
  const retry = useDocViewerStore((s) => s.retry)
  const openFile = useDocViewerStore((s) => s.openFile)
  const workspaceSlug = useDocViewerStore((s) => s.workspaceSlug)

  // Guard: routes navigation through unsaved-changes check (§17 R9)
  const guard = useUnsavedGuard()

  // §D-3: today's exact predicate, minus the http/// checks — MarkdownContent
  // now classifies any scheme-having or protocol-relative href as external
  // unconditionally, before this is ever called.
  const resolveLink = (href: string): (() => void) | null => {
    if (!href.endsWith('.md')) return null
    if (href.includes('..')) return null
    if (href.startsWith('/')) return null
    if (href.includes('\\')) return null
    if (!workspaceSlug || !file) return null
    const dir = file.filePath.split('/').slice(0, -1).join('/')
    const resolvedPath = dir + '/' + href
    return () => guard(() => openFile(resolvedPath, workspaceSlug, true))
  }

  if (fileLoading) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        <div className="h-6 bg-co-bg-tertiary rounded w-1/3" />
        <div className="h-4 bg-co-bg-tertiary rounded w-full" />
        <div className="h-4 bg-co-bg-tertiary rounded w-2/3" />
        <div className="h-4 bg-co-bg-tertiary rounded w-4/5" />
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

  if (!file) return <></>

  return (
    <div>
      {/* Back button — guarded (§17 R9) */}
      {openedFromFolder && (
        <button
          onClick={() => guard(navigateBack)}
          className="flex items-center gap-1.5 text-sm text-co-text-secondary hover:text-co-accent transition-colors mb-4"
        >
          <span>←</span>
          <span>Back to folder</span>
        </button>
      )}

      <MarkdownContent content={file.content} resolveLink={resolveLink} />
    </div>
  )
}
