import { useDocViewerStore } from '../../stores/docviewer-store'

interface PlainTextViewerProps {
  content: string
}

export function PlainTextViewer({ content }: PlainTextViewerProps) {
  const openedFromFolder = useDocViewerStore((s) => s.openedFromFolder)
  const navigateBack = useDocViewerStore((s) => s.navigateBack)

  return (
    <div>
      {openedFromFolder && (
        <button
          onClick={navigateBack}
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
