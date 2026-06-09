import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import matter from 'gray-matter'
import type { Components } from 'react-markdown'
import { useDocViewerStore } from '../../stores/docviewer-store'
import { friendlyDocError } from '../../utils/doc-errors'
import { FrontmatterDisplay } from './FrontmatterDisplay'

export function MarkdownViewer(): React.ReactElement {
  const file = useDocViewerStore((s) => s.file)
  const fileLoading = useDocViewerStore((s) => s.fileLoading)
  const error = useDocViewerStore((s) => s.error)
  const openedFromFolder = useDocViewerStore((s) => s.openedFromFolder)
  const navigateBack = useDocViewerStore((s) => s.navigateBack)
  const retry = useDocViewerStore((s) => s.retry)
  const openFile = useDocViewerStore((s) => s.openFile)
  const workspaceSlug = useDocViewerStore((s) => s.workspaceSlug)

  const parsed = useMemo(() => {
    if (!file) return null
    try {
      const { data, content } = matter(file.content, { engines: {} })
      return { frontmatter: data, content }
    } catch {
      // On gray-matter failure, render entire content as markdown
      return { frontmatter: {}, content: file.content }
    }
  }, [file])

  if (fileLoading) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        <div className="h-6 bg-co-bg-tertiary rounded w-1/3" />
        <div className="h-4 bg-co-bg-tertiary rounded w-full" />
        <div className="h-4 bg-co-bg-tertiary rounded w-2/3" />
        <div className="h-4 bg-co-bg-tertiary rounded w-4/5" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="text-co-status-attention text-sm">{friendlyDocError(error)}</div>
        <button
          onClick={retry}
          className="px-4 py-2 text-sm bg-co-accent/10 text-co-accent rounded-lg hover:bg-co-accent/20 transition-colors"
        >
          Try again
        </button>
      </div>
    )
  }

  if (!file || !parsed) return <></>

  const hasFrontmatter = Object.keys(parsed.frontmatter).length > 0

  // Custom components for react-markdown (A.7, A.10)
  const components: Components = {
    // A.7: External links render as span, relative .md links intercept
    a: ({ href, children }) => {
      if (!href) {
        return <span>{children}</span>
      }

      // Anchor links — scroll behavior
      if (href.startsWith('#')) {
        return <a href={href}>{children}</a>
      }

      // Relative .md links — intercept and openFile
      if (href.endsWith('.md') && !href.startsWith('http') && !href.startsWith('//')) {
        // Reject path traversal attempts
        if (href.includes('..')) {
          return <span>{children}</span>
        }
        const handleClick = (e: React.MouseEvent) => {
          e.preventDefault()
          if (workspaceSlug && file) {
            // Resolve relative to current file's directory
            const dir = file.filePath.split('/').slice(0, -1).join('/')
            const resolvedPath = dir + '/' + href
            openFile(resolvedPath, workspaceSlug, true)
          }
        }
        return (
          <a href={href} onClick={handleClick} className="cursor-pointer">
            {children}
          </a>
        )
      }

      // External links — render as span (A.7)
      return (
        <span className="co-prose-link-blocked" title="External links are disabled">
          {children}
        </span>
      )
    },

    // A.10: Image placeholder
    img: ({ alt }) => (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-co-bg-tertiary border border-co-border rounded text-xs text-co-text-muted">
        🖼️ {alt || 'Image'}
      </span>
    ),
  }

  return (
    <div>
      {/* Back button */}
      {openedFromFolder && (
        <button
          onClick={navigateBack}
          className="flex items-center gap-1.5 text-sm text-co-text-secondary hover:text-co-accent transition-colors mb-4"
        >
          <span>←</span>
          <span>Back to folder</span>
        </button>
      )}

      {/* Frontmatter */}
      {hasFrontmatter && <FrontmatterDisplay data={parsed.frontmatter} />}

      {/* Markdown content */}
      <div className="co-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[]}
          components={components}
        >
          {parsed.content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
