import React, { Suspense, useEffect, useRef, useCallback } from 'react'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard'
import { friendlyDocError } from '../../utils/doc-errors'
import { isEditable } from '../../utils/doc-editable'
import { FolderBrowser } from './FolderBrowser'
import { DocEditor } from './DocEditor'

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
  const workspaceSlug = useDocViewerStore((s) => s.workspaceSlug)
  const openFile = useDocViewerStore((s) => s.openFile)

  // Edit/dirty/save state
  const editing = useDocViewerStore((s) => s.editing)
  const draft = useDocViewerStore((s) => s.draft)
  const savedContent = useDocViewerStore((s) => s.savedContent)
  const saving = useDocViewerStore((s) => s.saving)
  const saveError = useDocViewerStore((s) => s.saveError)
  const enterEdit = useDocViewerStore((s) => s.enterEdit)
  const cancelEdit = useDocViewerStore((s) => s.cancelEdit)
  const save = useDocViewerStore((s) => s.save)

  // Compute dirty inline (avoids calling the store's isDirty() method from render)
  const dirty = editing && draft !== savedContent
  const editable = isEditable(file)

  // Guard: routes close/cancel through unsaved-changes check (§17 R9)
  const guard = useUnsavedGuard()

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

  // Cmd/Ctrl+S → save() while in Edit mode (§17 R20)
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (editing && (e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      void save()
    }
  }, [editing, save])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Backdrop click → guard(close) (§17 R9)
  const handleDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      guard(close)
    }
  }, [guard, close])

  // Escape key → guard(close) (§17 R9)
  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault()
    guard(close)
  }, [guard, close])

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
        {/* Close button — guard(close) (§17 R9) */}
        <button
          onClick={() => guard(close)}
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full text-co-text-muted hover:text-co-text-primary hover:bg-co-bg-tertiary transition-colors"
          aria-label="Close document viewer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        {/* File name header + Edit/Save/Cancel cluster.
            pr-14 reserves space for the absolutely-positioned close (X) button
            (top-3 right-3, w-8 → ~44px) so the button cluster never sits under
            its hit-area, which would swallow Edit/Save/Cancel clicks. */}
        {mode === 'file' && file && !isLoading && !error && (
          <div className="pl-6 pr-14 pt-4 pb-0 flex items-center justify-between">
            {/* File name — dirty indicator (§17 R21) */}
            <h2 className="text-sm font-medium text-co-text-secondary truncate">
              {file.name}{dirty && <span aria-label="unsaved changes"> ·</span>}
            </h2>

            {/* Button cluster */}
            <div className="flex items-center gap-2 ml-3 flex-shrink-0">
              {!editing ? (
                /* View mode: Edit button (§17 R12 — disabled w/ tooltip, never hidden) */
                <button
                  onClick={enterEdit}
                  disabled={!editable}
                  aria-label={editable ? `Edit ${file.name}` : 'Editing not supported for this file type'}
                  title={!editable ? 'Editing not supported for this file type' : undefined}
                  className="px-3 py-1 text-xs rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-co-accent/10 text-co-accent hover:bg-co-accent/20"
                >
                  Edit
                </button>
              ) : (
                /* Edit mode: Save + Cancel (Cancel routes through guard — §17 R9) */
                <>
                  <button
                    onClick={() => { void save() }}
                    disabled={!dirty || saving}
                    className="px-3 py-1 text-xs rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-co-accent/10 text-co-accent hover:bg-co-accent/20"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => guard(cancelEdit)}
                    disabled={saving}
                    className="px-3 py-1 text-xs rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-co-text-secondary hover:text-co-text-primary bg-co-bg-tertiary hover:bg-co-bg-tertiary/80"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Save error bar — pinned at top of content area, outside scroll (§17 R18) */}
        {mode === 'file' && saveError && !isLoading && (
          <div className="mx-6 mt-2 px-3 py-2 rounded-lg bg-co-status-attention/10 border border-co-status-attention/30 flex items-center justify-between gap-2 flex-shrink-0">
            <span className="text-xs text-co-status-attention">{friendlyDocError(saveError)}</span>
            {saveError.code === 'STALE_WRITE' && file && workspaceSlug && (
              <button
                onClick={() => openFile(file.filePath, workspaceSlug)}
                className="text-xs text-co-accent hover:underline flex-shrink-0"
              >
                Reload file
              </button>
            )}
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 overflow-y-auto p-6 pt-4 min-h-0">
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
            editing ? <DocEditor /> : <FileViewer />
          )}
        </div>
      </div>
    </dialog>
  )
}
