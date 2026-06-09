import React, { Suspense } from 'react'
import { useDocViewerStore } from '../../../stores/docviewer-store'
import { FolderBrowser } from '../../docviewer/FolderBrowser'
import { friendlyDocError } from '../../../utils/doc-errors'

const MarkdownViewer = React.lazy(() =>
  import('../../docviewer/MarkdownViewer').then((m) => ({ default: m.MarkdownViewer }))
)
const YamlViewer = React.lazy(() =>
  import('../../docviewer/YamlViewer').then((m) => ({ default: m.YamlViewer }))
)
const PlainTextViewer = React.lazy(() =>
  import('../../docviewer/PlainTextViewer').then((m) => ({ default: m.PlainTextViewer }))
)

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

export function RealmDocViewer(): React.ReactElement | null {
  const mode = useDocViewerStore((s) => s.mode)
  const file = useDocViewerStore((s) => s.file)
  const fileLoading = useDocViewerStore((s) => s.fileLoading)
  const treeLoading = useDocViewerStore((s) => s.treeLoading)
  const error = useDocViewerStore((s) => s.error)
  const close = useDocViewerStore((s) => s.close)
  const retry = useDocViewerStore((s) => s.retry)

  if (mode === 'closed') return null

  const isLoading = treeLoading || fileLoading

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        background: 'rgba(10,6,2,0.85)',
        border: '1px solid rgba(201,168,76,0.4)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'serif',
        color: '#e8d5a3',
      }}
      aria-label="Document viewer"
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid rgba(201,168,76,0.25)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: '#c9a84c', textTransform: 'uppercase', letterSpacing: 1 }}>
          {mode === 'file' && file ? file.name : 'Documents'}
        </span>
        <button
          type="button"
          onClick={close}
          aria-label="Close document viewer"
          style={{
            background: 'transparent',
            border: '1px solid rgba(201,168,76,0.3)',
            borderRadius: 4,
            color: '#9c8a6a',
            fontSize: 11,
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          ← Back
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {isLoading && <LoadingFallback />}

        {error && !isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
            <div style={{ fontSize: 12, color: '#e05c5c' }}>{friendlyDocError(error)}</div>
            <button
              type="button"
              onClick={retry}
              style={{
                fontSize: 11,
                padding: '4px 12px',
                background: 'rgba(201,168,76,0.1)',
                border: '1px solid rgba(201,168,76,0.3)',
                borderRadius: 4,
                color: '#c9a84c',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
        )}

        {!isLoading && !error && mode === 'folder' && <FolderBrowser />}
        {!isLoading && !error && mode === 'file' && <FileViewer />}
      </div>
    </div>
  )
}
