import React, { Suspense, useCallback, useEffect, useRef } from 'react'
import { useDocViewerStore } from '../../../stores/docviewer-store'
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard'
import { FolderBrowser } from '../../docviewer/FolderBrowser'
import { DocEditor } from '../../docviewer/DocEditor'
import { friendlyDocError } from '../../../utils/doc-errors'
import { isEditable } from '../../../utils/doc-editable'

const MarkdownViewer = React.lazy(() =>
  import('../../docviewer/MarkdownViewer').then((m) => ({ default: m.MarkdownViewer }))
)
const YamlViewer = React.lazy(() =>
  import('../../docviewer/YamlViewer').then((m) => ({ default: m.YamlViewer }))
)
const PlainTextViewer = React.lazy(() =>
  import('../../docviewer/PlainTextViewer').then((m) => ({ default: m.PlainTextViewer }))
)

// ---------------------------------------------------------------------------
// Realm inline style tokens — keep in sync with existing Realm chrome
// ---------------------------------------------------------------------------
const GOLD = '#c9a84c'
const GOLD_DIM = 'rgba(201,168,76,0.3)'
const GOLD_BG = 'rgba(201,168,76,0.12)'
const TEXT_PRIMARY = '#e8d5a3'
const TEXT_MUTED = '#9c8a6a'
const ERROR_RED = '#e05c5c'

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LoadingFallback(): React.ReactElement {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ height: 14, background: 'rgba(201,168,76,0.1)', borderRadius: 4, marginBottom: 8 }} />
      <div style={{ height: 10, background: 'rgba(201,168,76,0.08)', borderRadius: 4, marginBottom: 6, width: '66%' }} />
      <div style={{ height: 10, background: 'rgba(201,168,76,0.08)', borderRadius: 4, width: '50%' }} />
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

// Minimal focus-trap ref to keep keyboard focus inside the overlay during edit
// mode (§17 R17 — Realm <div> doesn't get the native <dialog> focus trap).
function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    function getFocusable(): HTMLElement[] {
      return Array.from(
        container!.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => { container.removeEventListener('keydown', handleKeyDown) }
  }, [active])

  return containerRef
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RealmDocViewer(): React.ReactElement | null {
  const mode = useDocViewerStore((s) => s.mode)
  const file = useDocViewerStore((s) => s.file)
  const fileLoading = useDocViewerStore((s) => s.fileLoading)
  const treeLoading = useDocViewerStore((s) => s.treeLoading)
  const error = useDocViewerStore((s) => s.error)
  const openedFromFolder = useDocViewerStore((s) => s.openedFromFolder)

  const editing = useDocViewerStore((s) => s.editing)
  const draft = useDocViewerStore((s) => s.draft)
  const savedContent = useDocViewerStore((s) => s.savedContent)
  const saving = useDocViewerStore((s) => s.saving)
  const saveError = useDocViewerStore((s) => s.saveError)
  // M1: compute dirty inline from subscribed primitives — avoids stale function-ref subscription
  const dirty = editing && draft !== savedContent

  const close = useDocViewerStore((s) => s.close)
  const navigateBack = useDocViewerStore((s) => s.navigateBack)
  const retry = useDocViewerStore((s) => s.retry)
  const enterEdit = useDocViewerStore((s) => s.enterEdit)
  const cancelEdit = useDocViewerStore((s) => s.cancelEdit)
  const save = useDocViewerStore((s) => s.save)
  const openFile = useDocViewerStore((s) => s.openFile)
  const workspaceSlug = useDocViewerStore((s) => s.workspaceSlug)

  // Guard: routes close/cancel/back through unsaved-changes check (§17 R9)
  const guard = useUnsavedGuard()

  // Focus trap during edit mode (§17 R17)
  const containerRef = useFocusTrap(editing)

  // Cmd/Ctrl+S → save() when in edit mode (§17 R20)
  useEffect(() => {
    if (!editing) return

    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => { window.removeEventListener('keydown', handleKeyDown) }
  }, [editing, save])

  // Back/close — guarded (§17 R9 + R10)
  const handleBack = useCallback(() => {
    if (openedFromFolder) {
      guard(navigateBack)
    } else {
      guard(close)
    }
  }, [guard, openedFromFolder, navigateBack, close])

  // Reload for STALE_WRITE: re-open the current file (§17 R2)
  const handleReload = useCallback(() => {
    if (!file || !workspaceSlug) return
    openFile(file.filePath, workspaceSlug, openedFromFolder)
  }, [file, workspaceSlug, openFile, openedFromFolder])

  if (mode === 'closed') return null

  const isLoading = treeLoading || fileLoading
  const editable = isEditable(file)
  const titleLabel = mode === 'file' && file
    ? (dirty ? `· ${file.name}` : file.name)
    : 'Documents'

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        background: 'rgba(10,6,2,0.85)',
        border: `1px solid ${GOLD_DIM}`,
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'serif',
        color: TEXT_PRIMARY,
      }}
      aria-label="Document viewer"
      role="region"
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: `1px solid rgba(201,168,76,0.25)`,
          flexShrink: 0,
          gap: 8,
        }}
      >
        {/* Title — dirty indicator (§17 R21) */}
        <span
          style={{ fontSize: 12, color: GOLD, textTransform: 'uppercase', letterSpacing: 1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={dirty ? 'Unsaved changes' : undefined}
        >
          {titleLabel}
        </span>

        {/* Button cluster — mirrors DocViewerOverlay (§5.4) */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {mode === 'file' && !editing && (
            // Edit button — disabled with tooltip for non-editable types (§17 R12)
            <button
              type="button"
              onClick={() => { if (editable) enterEdit() }}
              disabled={!editable}
              aria-label={editable ? `Edit ${file?.name ?? 'document'}` : 'Editing not supported for this file type'}
              title={editable ? undefined : 'Editing not supported for this file type'}
              style={{
                background: editable ? GOLD_BG : 'transparent',
                border: `1px solid ${editable ? GOLD_DIM : 'rgba(201,168,76,0.12)'}`,
                borderRadius: 4,
                color: editable ? GOLD : 'rgba(201,168,76,0.3)',
                fontSize: 11,
                padding: '2px 8px',
                cursor: editable ? 'pointer' : 'not-allowed',
                fontFamily: 'serif',
              }}
            >
              Edit
            </button>
          )}

          {mode === 'file' && editing && (
            <>
              {/* Save button — disabled when nothing to save or already saving (§17 R13) */}
              <button
                type="button"
                onClick={() => { void save() }}
                disabled={!dirty || saving}
                aria-label={saving ? 'Saving…' : 'Save document'}
                style={{
                  background: dirty && !saving ? GOLD_BG : 'transparent',
                  border: `1px solid ${dirty && !saving ? GOLD_DIM : 'rgba(201,168,76,0.12)'}`,
                  borderRadius: 4,
                  color: dirty && !saving ? GOLD : 'rgba(201,168,76,0.3)',
                  fontSize: 11,
                  padding: '2px 8px',
                  cursor: dirty && !saving ? 'pointer' : 'not-allowed',
                  fontFamily: 'serif',
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>

              {/* Cancel — guarded (§17 R9); disabled while saving (m1 parity) */}
              <button
                type="button"
                onClick={() => guard(cancelEdit)}
                disabled={saving}
                aria-label="Cancel editing"
                style={{
                  background: 'transparent',
                  border: `1px solid ${saving ? 'rgba(201,168,76,0.12)' : GOLD_DIM}`,
                  borderRadius: 4,
                  color: saving ? 'rgba(156,138,106,0.4)' : TEXT_MUTED,
                  fontSize: 11,
                  padding: '2px 8px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontFamily: 'serif',
                }}
              >
                Cancel
              </button>
            </>
          )}

          {/* Back/close — guarded (§17 R9 + R10) */}
          <button
            type="button"
            onClick={handleBack}
            aria-label="Close document viewer"
            style={{
              background: 'transparent',
              border: `1px solid ${GOLD_DIM}`,
              borderRadius: 4,
              color: TEXT_MUTED,
              fontSize: 11,
              padding: '2px 8px',
              cursor: 'pointer',
              fontFamily: 'serif',
            }}
          >
            ← Back
          </button>
        </div>
      </div>

      {/* Save error bar — pinned outside scroll region (§17 R18); only in file mode (m2 parity) */}
      {mode === 'file' && saveError && !isLoading && (
        <div
          role="alert"
          style={{
            padding: '6px 14px',
            borderBottom: `1px solid rgba(224,92,92,0.3)`,
            background: 'rgba(224,92,92,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
            gap: 8,
          }}
        >
          <span style={{ fontSize: 11, color: ERROR_RED }}>
            {friendlyDocError(saveError)}
          </span>
          {saveError.code === 'STALE_WRITE' && (
            <button
              type="button"
              onClick={handleReload}
              style={{
                background: 'transparent',
                border: `1px solid rgba(201,168,76,0.3)`,
                borderRadius: 4,
                color: GOLD,
                fontSize: 11,
                padding: '2px 8px',
                cursor: 'pointer',
                fontFamily: 'serif',
                flexShrink: 0,
              }}
            >
              Reload
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: editing ? 'hidden' : 'auto', padding: editing ? 0 : '12px 14px', display: 'flex', flexDirection: 'column' }}>
        {isLoading && <LoadingFallback />}

        {error && !isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
            <div style={{ fontSize: 12, color: ERROR_RED }}>{friendlyDocError(error)}</div>
            <button
              type="button"
              onClick={retry}
              style={{
                fontSize: 11,
                padding: '4px 12px',
                background: GOLD_BG,
                border: `1px solid ${GOLD_DIM}`,
                borderRadius: 4,
                color: GOLD,
                cursor: 'pointer',
                fontFamily: 'serif',
              }}
            >
              Try again
            </button>
          </div>
        )}

        {!isLoading && !error && mode === 'folder' && <FolderBrowser />}

        {!isLoading && !error && mode === 'file' && !editing && <FileViewer />}

        {!isLoading && !error && mode === 'file' && editing && (
          // DocEditor fills the content area in edit mode; padding applied on the textarea via DocEditor
          <div style={{ flex: 1, padding: '12px 14px', display: 'flex', flexDirection: 'column' }}>
            <DocEditor />
          </div>
        )}
      </div>
    </div>
  )
}
