import React from 'react'

interface FrontmatterDisplayProps {
  data: Record<string, unknown>
}

function renderValue(value: unknown): React.ReactNode {
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((item, i) => (
          <span
            key={i}
            className="px-2 py-0.5 text-xs bg-co-bg-primary rounded-full text-co-text-secondary"
          >
            {String(item)}
          </span>
        ))}
      </div>
    )
  }

  if (value !== null && typeof value === 'object') {
    return (
      <div className="pl-3 border-l border-co-border flex flex-col gap-1.5 mt-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}>
            <span className="font-mono text-xs text-co-text-muted">{k}:</span>{' '}
            <span className="text-sm text-co-text-secondary">{renderValue(v)}</span>
          </div>
        ))}
      </div>
    )
  }

  return <span>{String(value)}</span>
}

export function FrontmatterDisplay({ data }: FrontmatterDisplayProps): React.ReactElement {
  const entries = Object.entries(data)
  if (entries.length === 0) return <></>

  return (
    <div className="co-card bg-co-bg-tertiary p-4 flex flex-col gap-2 border-b border-co-border mb-4">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-3">
          <span className="font-mono text-xs text-co-text-muted min-w-[100px] shrink-0 pt-0.5">
            {key}
          </span>
          <div className="text-sm text-co-text-secondary">
            {renderValue(value)}
          </div>
        </div>
      ))}
    </div>
  )
}
