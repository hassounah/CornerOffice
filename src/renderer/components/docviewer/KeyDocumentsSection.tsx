import React from 'react'
import type { DocTreeEntry } from '@main/types/docs'
import { FileTreeItem } from './FileTreeItem'

interface KeyDocumentsSectionProps {
  entries: DocTreeEntry[]
}

export function KeyDocumentsSection({ entries }: KeyDocumentsSectionProps): React.ReactElement {
  const keyDocs = entries.filter((e) => e.isKeyDocument && !e.isHidden)

  if (keyDocs.length === 0) return <></>

  return (
    <div className="co-card border-l-2 border-co-accent/30 bg-co-bg-tertiary/50 p-3 flex flex-col gap-0.5">
      <div className="text-xs text-co-text-muted font-medium mb-2">Key Documents</div>
      {keyDocs.map((entry) => (
        <FileTreeItem key={entry.path} entry={entry} />
      ))}
    </div>
  )
}
