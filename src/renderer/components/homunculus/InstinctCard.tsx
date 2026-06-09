import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Instinct } from '@main/types/homunculus'

interface InstinctCardProps {
  instinct: Instinct
}

export function InstinctCard({ instinct }: InstinctCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  const confidencePct = Math.round(instinct.confidence * 100)
  const confidenceColor =
    instinct.confidence >= 0.8
      ? 'bg-green-500'
      : instinct.confidence >= 0.5
        ? 'bg-yellow-500'
        : 'bg-red-500/60'
  const confidenceLabel =
    instinct.confidence >= 0.8 ? 'High' : instinct.confidence >= 0.5 ? 'Medium' : 'Low'

  return (
    <div className="rounded-lg border border-white/[0.04] bg-co-bg-elevated">
      {/* Header — always visible */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`instinct-body-${instinct.id}`}
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex flex-col gap-2 p-4 text-left hover:bg-white/5 transition-colors"
      >
        {/* Top row: ID + domain badge + type badge */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-mono text-co-text-muted shrink-0">
            {instinct.id}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-co-accent/20 text-co-accent font-medium">
            {instinct.domain}
          </span>
          <span className={[
            'text-[10px] px-1.5 py-0.5 rounded-full font-medium ml-auto',
            instinct.type === 'personal'
              ? 'bg-blue-900/40 text-blue-300'
              : 'bg-gray-700 text-gray-300',
          ].join(' ')}>
            {instinct.type}
          </span>
        </div>

        {/* Trigger */}
        <p className="text-sm text-co-text-primary">{instinct.trigger}</p>

        {/* Confidence bar */}
        <div className="flex items-center gap-2">
          <div
            className="flex-1 h-1.5 rounded-full bg-co-bg-tertiary overflow-hidden"
            role="img"
            aria-label={`Confidence: ${confidencePct}% (${confidenceLabel})`}
          >
            <div
              className={`h-full rounded-full transition-all ${confidenceColor}`}
              style={{ width: `${confidencePct}%` }}
            />
          </div>
          <span className="text-[10px] text-co-text-muted tabular-nums shrink-0">
            {confidencePct}%
          </span>
          <span className="text-[10px] text-co-text-muted shrink-0">
            {instinct.source}
          </span>
        </div>
      </button>

      {/* Expandable body — markdown content */}
      {expanded && (
        <div
          id={`instinct-body-${instinct.id}`}
          className="px-4 pb-4 border-t border-white/[0.04]"
        >
          <div className="co-prose pt-3 text-co-text-secondary">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              allowedElements={[
                'p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre',
                'h1', 'h2', 'h3', 'h4', 'blockquote',
              ]}
              unwrapDisallowed
            >
              {instinct.content}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
