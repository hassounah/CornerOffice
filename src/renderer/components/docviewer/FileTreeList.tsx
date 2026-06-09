import React, { useState } from 'react'
import type { DocTreeEntry } from '@main/types/docs'
import { FileTreeItem } from './FileTreeItem'

interface GroupProps {
  label: string
  count: number
  defaultOpen: boolean
  children: React.ReactNode
}

function CollapsibleGroup({ label, count, defaultOpen, children }: GroupProps): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-xs text-co-text-muted py-1.5 px-1 hover:text-co-text-secondary transition-colors"
      >
        <span aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        <span>{label}</span>
        <span className="text-co-text-muted/60">({count})</span>
      </button>
      {open && <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  )
}

interface FileTreeListProps {
  entries: DocTreeEntry[]
}

export function FileTreeList({ entries }: FileTreeListProps): React.ReactElement {
  // Categorize entries — key documents are shown in KeyDocumentsSection, everything else here
  const categorized = new Set<DocTreeEntry>()

  const directories = entries.filter((e) => {
    if (e.type === 'directory' && !e.isTeamArtifact && !e.isHandoffs && !e.isHidden) {
      categorized.add(e)
      return true
    }
    return false
  })

  const teamWorkspaces = entries.filter((e) => {
    if (e.isTeamArtifact && !e.isKeyDocument) {
      categorized.add(e)
      return true
    }
    return false
  })

  const handoffs = entries.filter((e) => {
    if (e.isHandoffs && !e.isKeyDocument) {
      categorized.add(e)
      return true
    }
    return false
  })

  const files = entries.filter((e) => {
    if (e.type === 'file' && !e.isKeyDocument && !e.isHidden) {
      categorized.add(e)
      return true
    }
    return false
  })

  // Extras: anything not categorized above and not a key document (shown elsewhere)
  const extras = entries.filter((e) => !categorized.has(e) && !e.isKeyDocument)

  const hasDirectories = directories.length > 0
  const hasTeamWorkspaces = teamWorkspaces.length > 0
  const hasHandoffs = handoffs.length > 0
  const hasFiles = files.length > 0
  const hasExtras = extras.length > 0

  if (!hasDirectories && !hasTeamWorkspaces && !hasHandoffs && !hasFiles && !hasExtras) {
    return (
      <div className="text-sm text-co-text-muted py-4 text-center">
        No items in this directory
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {hasDirectories && (
        <CollapsibleGroup label="Directories" count={directories.length} defaultOpen={true}>
          {directories.map((entry) => (
            <FileTreeItem key={entry.path} entry={entry} />
          ))}
        </CollapsibleGroup>
      )}

      {hasFiles && (
        <div className="flex flex-col gap-0.5">
          {files.map((entry) => (
            <FileTreeItem key={entry.path} entry={entry} />
          ))}
        </div>
      )}

      {hasTeamWorkspaces && (
        <CollapsibleGroup label="Team Workspaces" count={teamWorkspaces.length} defaultOpen={false}>
          {teamWorkspaces.map((entry) => (
            <FileTreeItem key={entry.path} entry={entry} />
          ))}
        </CollapsibleGroup>
      )}

      {hasHandoffs && (
        <CollapsibleGroup label="Handoffs" count={handoffs.length} defaultOpen={false}>
          {handoffs.map((entry) => (
            <FileTreeItem key={entry.path} entry={entry} />
          ))}
        </CollapsibleGroup>
      )}

      {hasExtras && (
        <CollapsibleGroup label="Extras" count={extras.length} defaultOpen={false}>
          {extras.map((entry) => (
            <FileTreeItem key={entry.path} entry={entry} />
          ))}
        </CollapsibleGroup>
      )}
    </div>
  )
}
