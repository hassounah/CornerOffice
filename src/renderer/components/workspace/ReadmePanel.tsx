import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// NOTE: rehype-raw and rehype-sanitize are intentionally NOT used.
// react-markdown's default behavior escapes raw HTML, preventing XSS.

interface ReadmePanelProps {
  content: string | null
}

export function ReadmePanel({ content }: ReadmePanelProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)

  if (content === null) return null

  return (
    <section aria-label="README panel">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((p) => !p)}
        className="flex items-center gap-2 w-full text-left group"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-co-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4" />
        </svg>
        <h3 className="text-xs font-semibold text-co-text-muted uppercase tracking-wider group-hover:text-co-text-secondary transition-colors">
          README
        </h3>
      </button>

      {expanded && (
        <div className="mt-3 co-card p-4 max-h-96 overflow-y-auto">
          <div className="co-prose text-co-text-secondary">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              // No rehype-raw — raw HTML in markdown content is escaped, not rendered
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    className="text-co-accent hover:underline"
                    onClick={(e) => e.preventDefault()}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </section>
  )
}
