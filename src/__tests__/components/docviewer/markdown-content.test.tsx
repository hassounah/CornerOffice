import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownContent } from '../../../renderer/components/docviewer/MarkdownContent'
import { MarkdownViewer } from '../../../renderer/components/docviewer/MarkdownViewer'
import { useDocViewerStore } from '../../../renderer/stores/docviewer-store'

// ---------------------------------------------------------------------------
// These tests run against the REAL react-markdown and front matter parser (no mocks),
// exercising MarkdownContent's own link classification, button-as-link
// rendering (Addendum A1(2)) and the front matter engine guard (Sec M-4).
// ---------------------------------------------------------------------------

beforeEach(() => {
  // @ts-expect-error — test-only pollution target for the front-matter-engine assertions.
  delete globalThis.__pwn
})

describe('MarkdownContent — anchor and image handling (unchanged)', () => {
  it('renders an in-page anchor link as a real <a href>', () => {
    const { container } = render(<MarkdownContent content="[jump](#section)" />)
    const a = container.querySelector('a[href="#section"]')
    expect(a).not.toBeNull()
  })

  it('renders an image as a placeholder, never an <img> element', () => {
    const { container } = render(<MarkdownContent content="![alt text](pic.png)" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('alt text')
  })
})

describe('MarkdownContent — resolveLink contract', () => {
  it('resolveLink returning null gives plain, non-clickable text', () => {
    const { container, getByText } = render(
      <MarkdownContent content="[go](notes.md)" resolveLink={() => null} />
    )
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('a[href="notes.md"]')).toBeNull()
    expect(getByText('go')).toBeDefined()
  })

  it('resolveLink returning a callback renders button[role="link"] with no href attribute anywhere', () => {
    const onOpen = () => {}
    const { container, getByRole } = render(
      <MarkdownContent content="[go](notes.md)" resolveLink={(href) => (href === 'notes.md' ? onOpen : null)} />
    )
    const btn = getByRole('link', { name: 'go' })
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
    expect(container.querySelector('[href]')).toBeNull()
  })

  it('clicking the button-as-link calls the resolveLink callback, not a navigation', () => {
    let called = false
    const { getByRole } = render(
      <MarkdownContent content="[go](notes.md)" resolveLink={() => () => { called = true }} />
    )
    getByRole('link', { name: 'go' }).click()
    expect(called).toBe(true)
  })

  it('with no resolveLink prop at all, a relative link renders as plain text', () => {
    const { container } = render(<MarkdownContent content="[go](notes.md)" />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
  })
})

describe('MarkdownContent — external links are always blocked (Sec H-3)', () => {
  it.each([
    ['https://example.com', 'https link'],
    ['http://example.com', 'http link'],
    ['mailto:evil@example.com', 'mailto link'],
    ['//evil.example.com/x', 'protocol-relative link'],
  ])('%s renders as co-prose-link-blocked, never resolveLink', (href, label) => {
    let resolveLinkCalled = false
    const { container } = render(
      <MarkdownContent
        content={`[${label}](${href})`}
        resolveLink={() => {
          resolveLinkCalled = true
          return () => {}
        }}
      />
    )
    const blocked = container.querySelector('.co-prose-link-blocked')
    expect(blocked).not.toBeNull()
    expect(blocked?.textContent).toBe(label)
    expect(container.querySelector('[href]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(resolveLinkCalled).toBe(false)
  })

  it.each([
    ['file:///home/u/repo/payload.html', 'file link'],
    ['javascript:alert(1)', 'javascript link'],
  ])('%s produces no element with an href that navigates', (href, label) => {
    const { container } = render(
      <MarkdownContent content={`[${label}](${href})`} resolveLink={() => () => {}} />
    )
    expect(container.querySelector('[href]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('a relative non-.md link (payload.html) produces no href-bearing element, whatever resolveLink decides', () => {
    const { container } = render(<MarkdownContent content="[x](payload.html)" resolveLink={() => null} />)
    expect(container.querySelector('[href]')).toBeNull()
  })
})

describe('MarkdownContent — front matter engine stubs (Sec M-4)', () => {
  it('a ---js front matter block does not execute and set globalThis.__pwn', () => {
    render(<MarkdownContent content={'---js\n(globalThis.__pwn = 1)\n---\nbody'} />)
    expect((globalThis as Record<string, unknown>).__pwn).toBeUndefined()
  })

  it('a ---javascript front matter block does not execute and set globalThis.__pwn', () => {
    render(<MarkdownContent content={'---javascript\n(globalThis.__pwn = 1)\n---\nbody'} />)
    expect((globalThis as Record<string, unknown>).__pwn).toBeUndefined()
  })

  it('ordinary YAML front matter still renders via FrontmatterDisplay', () => {
    const { getByText } = render(<MarkdownContent content={'---\ntitle: Hello\n---\nbody'} />)
    expect(getByText('title')).toBeDefined()
  })

  it('malformed YAML front matter falls back to rendering the raw content as markdown', () => {
    const { getByText } = render(
      <MarkdownContent content={'---\nfoo: "unterminated\n---\nbody text'} />
    )
    // js-yaml throws on the unterminated quote; the catch branch
    // renders the whole input (front-matter fence included) as plain markdown.
    expect(getByText(/body text/)).toBeDefined()
  })
})

describe('MarkdownContent — XSS sanitization (parity with the react-markdown baseline)', () => {
  it('does not render <script> tags', () => {
    const { container } = render(<MarkdownContent content="Hello <script>alert(1)</script> world" />)
    expect(container.querySelector('script')).toBeNull()
  })

  it('does not render onerror attributes on img tags', () => {
    const { container } = render(<MarkdownContent content={'<img onerror="alert(1)" src="x">'} />)
    expect(container.querySelector('[onerror]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MarkdownViewer's resolveLink (§D-3) — the real docviewer store and the
// real react-markdown/front matter parser (not the mocks used by the other docviewer
// test files, which never exercise this closure at all).
// ---------------------------------------------------------------------------

function setViewerState(overrides: Partial<Record<string, unknown>>) {
  useDocViewerStore.setState({
    file: null,
    fileLoading: false,
    error: null,
    openedFromFolder: false,
    workspaceSlug: null,
    ...overrides,
  } as never)
}

describe('MarkdownViewer — resolveLink wiring (§D-3)', () => {
  afterEach(() => {
    setViewerState({})
  })

  it('a relative .md link with no .. calls openFile with the resolved path, guarded', () => {
    const openFile = vi.fn()
    setViewerState({
      file: { filePath: '/docs/notes/readme.md', content: '[other](other.md)' },
      workspaceSlug: 'ws1',
      openFile,
    })
    const { getByRole } = render(<MarkdownViewer />)
    getByRole('link', { name: 'other' }).click()
    expect(openFile).toHaveBeenCalledWith('/docs/notes/other.md', 'ws1', true)
  })

  it('a relative .md link containing .. is not resolved (no button, no href)', () => {
    const openFile = vi.fn()
    setViewerState({
      file: { filePath: '/docs/notes/readme.md', content: '[other](../secret/x.md)' },
      workspaceSlug: 'ws1',
      openFile,
    })
    const { container } = render(<MarkdownViewer />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('a leading-slash .md link is not resolved (no button, no href)', () => {
    const openFile = vi.fn()
    setViewerState({
      file: { filePath: '/readme.md', content: '[x](/etc/passwd.md)' },
      workspaceSlug: 'ws1',
      openFile,
    })
    const { container } = render(<MarkdownViewer />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  // A backslash-in-href rejection test does NOT belong here: real
  // react-markdown parsing always percent-encodes a raw backslash in a link
  // destination to `%5C` during micromark's own AST-building URI sanitizer,
  // well before it ever reaches resolveLink — so no markdown source string
  // can deliver a literal backslash character through this real, unmocked
  // pipeline. See markdown-viewer-resolve-link-backslash.test.tsx for the
  // (necessarily mocked) test of that branch, with the full explanation.

  it('a non-.md relative link is not resolved (no button, no href)', () => {
    const openFile = vi.fn()
    setViewerState({
      file: { filePath: '/docs/notes/readme.md', content: '[x](payload.html)' },
      workspaceSlug: 'ws1',
      openFile,
    })
    const { container } = render(<MarkdownViewer />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[href]')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('with no workspaceSlug, a relative .md link is not resolved', () => {
    const openFile = vi.fn()
    setViewerState({
      file: { filePath: '/docs/notes/readme.md', content: '[other](other.md)' },
      workspaceSlug: null,
      openFile,
    })
    const { container } = render(<MarkdownViewer />)
    expect(container.querySelector('button')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })
})
