import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// NOTE: rehype-raw and rehype-sanitize are intentionally NOT used.
// react-markdown's default behavior escapes raw HTML, preventing XSS.

interface MemoryPanelProps {
  content: string
}

export function MemoryPanel({ content }: MemoryPanelProps): React.ReactElement {
  return (
    <section aria-label="Memory panel">
      <div className="co-card p-4">
        <div className="co-prose text-co-text-secondary">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            // No rehype-raw — raw HTML in markdown content is escaped, not rendered
            components={{
              // Render links safely (no target override needed — Electron opens external links via shell)
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
    </section>
  )
}
