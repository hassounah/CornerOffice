import { useDocViewerStore } from '../../stores/docviewer-store'
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard'

interface PlainTextViewerProps {
  content: string
}

export function PlainTextViewer({ content }: PlainTextViewerProps) {
  const openedFromFolder = useDocViewerStore((s) => s.openedFromFolder)
  const navigateBack = useDocViewerStore((s) => s.navigateBack)
  // Guard: routes navigation through unsaved-changes check (§17 R9)
  const guard = useUnsavedGuard()

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
      <div className="co-card p-4">
        <pre className="font-mono text-sm text-co-text-secondary whitespace-pre-wrap break-words">
          {content}
        </pre>
      </div>
    </div>
  )
}
