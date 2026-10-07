import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { FrontmatterDisplay } from './FrontmatterDisplay'
import { parseFrontmatter } from '../../utils/frontmatter'

// ---------------------------------------------------------------------------
// MarkdownContent — shared markdown rendering for the doc viewer and the code
// explorer's Preview (TRD §3.6.7, Addendum A1(2), Sec H-3, M-4).
//
// A resolvable link renders as <button type="button" role="link"
// className="co-prose-link">, never <a href>: the raw href never reaches the
// DOM, so there is no middle-click or context-menu navigation. Each caller
// supplies its own `resolveLink` — the doc viewer resolves repo-relative .md
// links (§D-3), the code explorer resolves safe repo-relative paths (2.17) —
// but "external" (any URL with a scheme, or a protocol-relative //url) is
// classified here, unconditionally, so both callers get identical blocked-
// link treatment without duplicating that check.
// ---------------------------------------------------------------------------

export interface MarkdownContentProps {
  content: string
  /**
   * Called for any non-anchor, non-external href. Return a callback to open
   * it (rendered as a button-as-link) or null to render plain, non-clickable
   * text. Omit entirely to treat every such href as unresolvable.
   */
  resolveLink?: (href: string) => (() => void) | null
}

// Any URL with an explicit scheme ("http:", "file:", "javascript:", "mailto:", …)
// or a protocol-relative "//host/…" — never passed to resolveLink.
const EXTERNAL_HREF = /^[a-z][a-z0-9+.-]*:/i

function isExternalHref(href: string): boolean {
  return EXTERNAL_HREF.test(href) || href.startsWith('//')
}

export function MarkdownContent({ content, resolveLink }: MarkdownContentProps): React.ReactElement {
  const parsed = useMemo(() => {
    try {
      // Sec M-4: parseFrontmatter only accepts a plain `---` YAML fence, so a
      // "---js" block is never evaluated — it renders as ordinary markdown.
      const { data, content: body } = parseFrontmatter(content)
      return { frontmatter: data, content: body }
    } catch {
      // On malformed front matter, render the entire input as markdown.
      return { frontmatter: {}, content }
    }
  }, [content])

  const hasFrontmatter = Object.keys(parsed.frontmatter).length > 0

  const components: Components = {
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>

      // Anchor links — same-document scroll, unchanged.
      if (href.startsWith('#')) return <a href={href}>{children}</a>

      if (isExternalHref(href)) {
        return (
          <span className="co-prose-link-blocked" title="External links are disabled">
            {children}
          </span>
        )
      }

      const onOpen = resolveLink?.(href)
      if (onOpen) {
        return (
          <button type="button" role="link" className="co-prose-link" onClick={onOpen}>
            {children}
          </button>
        )
      }

      // resolveLink declined (or none was supplied) — not a link, just text.
      return <span>{children}</span>
    },

    img: ({ alt }) => (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-co-bg-tertiary border border-co-border rounded text-xs text-co-text-muted">
        🖼️ {alt || 'Image'}
      </span>
    ),
  }

  return (
    <>
      {hasFrontmatter && <FrontmatterDisplay data={parsed.frontmatter} />}
      <div className="co-prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[]} components={components}>
          {parsed.content}
        </ReactMarkdown>
      </div>
    </>
  )
}
