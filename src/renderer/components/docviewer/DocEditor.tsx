import React, { useEffect, useRef } from 'react'
import { useDocViewerStore } from '../../stores/docviewer-store'

/**
 * Controlled textarea editor bound to the docviewer store's draft / setDraft.
 * Used by both DocViewerOverlay (Office) and RealmDocViewer (Realm) — the skin
 * wraps it in its own chrome. Styling is minimal so each skin can size it freely.
 *
 * §17 R17 accessibility notes:
 *   - aria-label is dynamic: "Edit <filename>" (not a generic string)
 *   - Tab uses browser default (focus-move) — no tab-character insertion
 *   - Focuses the textarea on mount / entering edit mode
 */
export function DocEditor(): React.ReactElement {
  const file = useDocViewerStore((s) => s.file)
  const draft = useDocViewerStore((s) => s.draft)
  const setDraft = useDocViewerStore((s) => s.setDraft)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Focus on mount (entering edit mode)
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  return (
    <textarea
      ref={textareaRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      aria-label={file ? `Edit ${file.name}` : 'Edit document'}
      className="w-full h-full font-mono text-sm text-co-text-primary bg-co-bg-secondary border border-co-border rounded resize-none outline-none focus:border-co-accent p-3 whitespace-pre"
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
    />
  )
}
