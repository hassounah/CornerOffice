import React, { Suspense, useEffect, useRef } from 'react'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { friendlyDocError } from '../../utils/doc-errors'
import { FolderBrowser } from './FolderBrowser'

const MarkdownViewer = React.lazy(() =>
  import('./MarkdownViewer').then((m) => ({ default: m.MarkdownViewer }))
)
const YamlViewer = React.lazy(() =>
  import('./YamlViewer').then((m) => ({ default: m.YamlViewer }))
)
const PlainTextViewer = React.lazy(() =>
  import('./PlainTextViewer').then((m) => ({ default: m.PlainTextViewer }))
)

function LoadingFallback(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 co-animate-pulse">
      <div className="h-6 bg-co-bg-tertiary rounded w-1/3" />
      <div className="h-4 bg-co-bg-tertiary rounded w-2/3" />
      <div className="h-4 bg-co-bg-tertiary rounded w-1/2" />
    </div>
  )
}

function FileViewer(): React.ReactElement {
  const file = useDocViewerStore((s) => s.file)
  if (!file) return <></>

  switch (file.extension) {
    case 'md':
      return (
        <Suspense fallback={<LoadingFallback />}>
          <MarkdownViewer />
        </Suspense>
      )
    case 'yaml':
    case 'yml':
      return (
        <Suspense fallback={<LoadingFallback />}>
          <YamlViewer content={file.content} />
        </Suspense>
      )
    default:
      return (
        <Suspense fallback={<LoadingFallback />}>
          <PlainTextViewer content={file.content} />
        </Suspense>
      )
  }
}

export function DocViewerOverlay(): React.ReactElement | null {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<Element | null>(null)

  const mode = useDocViewerStore((s) => s.mode)
  const treeLoading = useDocViewerStore((s) => s.treeLoading)
  const fileLoading = useDocViewerStore((s) => s.fileLoading)
  const error = useDocViewerStore((s) => s.error)
  const close = useDocViewerStore((s) => s.close)
  const retry = useDocViewerStore((s) => s.retry)
  const file = useDocViewerStore((s) => s.file)

  const isOpen = mode !== 'closed'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (mode !== 'closed') {
      triggerRef.current = document.activeElement
      if (!dialog.open) {
        dialog.showModal()
      }
    } else {
      if (dialog.open) {
        dialog.close()
      }
      // Return focus to triggering element (A.3)
      if (triggerRef.current && triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus()
        triggerRef.current = null
      }
    }
  }, [mode])

  // Handle backdrop click
  const handleDialogClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      close()
    }
  }

  // Handle native dialog cancel (Escape key)
  const handleCancel = (e: React.SyntheticEvent) => {
    e.preventDefault()
    close()
  }

  const isLoading = treeLoading || fileLoading

  return (
    <dialog
      ref={dialogRef}
      className="co-docviewer-dialog"
      onClick={handleDialogClick}
      onCancel={handleCancel}
      aria-label="Document viewer"
    >
      <div
        key={isOpen ? 'open' : 'closed'}
        className="bg-co-bg-primary border border-co-border rounded-[0.75rem] shadow-2xl w-[70vw] max-w-5xl h-[80vh] flex flex-col relative co-animate-in"
      >
        {/* Close button */}
        <button
          onClick={close}
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full text-co-text-muted hover:text-co-text-primary hover:bg-co-bg-tertiary transition-colors"
          aria-label="Close document viewer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        {/* File name header */}
        {mode === 'file' && file && !isLoading && !error && (
          <div className="px-6 pt-4 pb-0">
            <h2 className="text-sm font-medium text-co-text-secondary truncate">{file.name}</h2>
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 overflow-y-auto p-6 pt-4">
          {isLoading && (
            <div className="flex flex-col gap-4 co-animate-pulse">
              <div className="h-6 bg-co-bg-tertiary rounded w-1/3" />
              <div className="h-4 bg-co-bg-tertiary rounded w-2/3" />
              <div className="h-4 bg-co-bg-tertiary rounded w-1/2" />
              <div className="flex flex-col gap-3 mt-6">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-10 bg-co-bg-tertiary rounded" />
                ))}
              </div>
            </div>
          )}

          {error && !isLoading && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="text-co-status-attention text-sm">
                {friendlyDocError(error)}
              </div>
              <button
                onClick={retry}
                className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent rounded-lg hover:bg-co-accent/20 transition-colors"
              >
                Try again
              </button>
            </div>
          )}

          {!isLoading && !error && mode === 'folder' && (
            <FolderBrowser />
          )}

          {!isLoading && !error && mode === 'file' && (
            <FileViewer />
          )}
        </div>
      </div>
    </dialog>
  )
}
