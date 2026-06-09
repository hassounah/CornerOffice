import React from 'react'
import type { DocTreeEntry } from '@main/types/docs'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { formatDistanceToNow } from 'date-fns'

function humanizeName(name: string): string {
  // Keep NN prefix for spawn order, strip leading dot
  const stripped = name.replace(/^\.(\d{2}-)/, '$1')
  return stripped
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(extension: string | null): string {
  switch (extension) {
    case 'md': return '📄'
    case 'yaml':
    case 'yml': return '⚙️'
    case 'txt': return '📝'
    default: return '📄'
  }
}

interface FileTreeItemProps {
  entry: DocTreeEntry
}

export function FileTreeItem({ entry }: FileTreeItemProps): React.ReactElement {
  const navigateToDir = useDocViewerStore((s) => s.navigateToDir)
  const openFile = useDocViewerStore((s) => s.openFile)
  const workspaceSlug = useDocViewerStore((s) => s.workspaceSlug)

  const handleClick = () => {
    if (entry.type === 'directory') {
      navigateToDir(entry.path)
    } else if (workspaceSlug) {
      openFile(entry.path, workspaceSlug, true)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    }
  }

  const isDir = entry.type === 'directory'
  const displayName = entry.isTeamArtifact
    ? humanizeName(entry.name)
    : entry.name
  const isDimmed = entry.isTeamArtifact || entry.isHandoffs

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={[
        'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
        'hover:bg-co-bg-tertiary',
        entry.isKeyDocument ? 'border-l-2 border-co-accent/30' : '',
        isDimmed ? 'opacity-60' : '',
      ].join(' ')}
    >
      {/* Icon */}
      <span className="text-sm shrink-0">
        {isDir
          ? (entry.isTeamArtifact ? '🏗️' : entry.isHandoffs ? '📦' : '📁')
          : getFileIcon(entry.extension)
        }
      </span>

      {/* Name */}
      <span className="flex-1 text-sm text-co-text-primary truncate">
        {displayName}
      </span>

      {/* Metadata */}
      {isDir ? (
        <>
          {entry.hasChildren && (
            <span className="text-co-text-muted text-xs" aria-hidden="true">›</span>
          )}
        </>
      ) : (
        <div className="flex items-center gap-3 text-xs text-co-text-muted shrink-0">
          {entry.size !== null && (
            <span>{formatSize(entry.size)}</span>
          )}
          <span>{formatDistanceToNow(new Date(entry.lastModified), { addSuffix: true })}</span>
        </div>
      )}
    </div>
  )
}
