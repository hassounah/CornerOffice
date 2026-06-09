import React, { useState } from 'react'

interface Props {
  onRetry?: () => void
  error?: Error | null
  componentStack?: string | null
}

export function PanelError({ onRetry, error, componentStack }: Props): React.ReactElement {
  const [showDetails, setShowDetails] = useState(false)

  const handleCopy = () => {
    const text = [
      error?.message,
      error?.stack,
      componentStack ? `Component stack:${componentStack}` : null,
    ].filter(Boolean).join('\n\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="flex flex-col items-center gap-3 text-center max-w-lg">
        <p className="text-sm text-co-text-muted">
          Something went wrong in this panel.
        </p>
        {error && (
          <p className="text-xs font-mono text-co-status-attention/80 break-all px-4">
            {error.message}
          </p>
        )}
        <div className="flex items-center gap-2">
          {onRetry && (
            <button
              onClick={onRetry}
              className="rounded-md px-3 py-1.5 text-xs font-medium bg-co-bg-tertiary text-co-text-primary hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-co-accent"
            >
              Retry
            </button>
          )}
          {error && (
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-co-text-muted hover:text-co-text-secondary transition-colors"
            >
              {showDetails ? 'Hide' : 'Details'}
            </button>
          )}
          {error && (
            <button
              onClick={handleCopy}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-co-text-muted hover:text-co-text-secondary transition-colors"
            >
              Copy
            </button>
          )}
        </div>
        {showDetails && error?.stack && (
          <pre className="mt-2 text-left text-[10px] leading-tight font-mono text-co-text-muted/70 bg-co-bg-tertiary rounded-lg p-3 max-h-48 overflow-auto w-full whitespace-pre-wrap break-all">
            {error.stack}
            {componentStack && (
              <>
                {'\n\nComponent stack:'}
                {componentStack}
              </>
            )}
          </pre>
        )}
      </div>
    </div>
  )
}
