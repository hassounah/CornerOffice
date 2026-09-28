import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Fix #115: MarkdownViewer's resolveLink must reject a leading `/` or a `\`
// in an href, alongside its existing `.md`/`..` checks.
//
// The leading-`/` case is covered end-to-end, against the REAL react-markdown
// pipeline, in markdown-content.test.tsx (no mocks there, by design).
//
// The backslash case cannot be: real react-markdown parsing always
// percent-encodes a raw backslash in a link destination to `%5C` — this
// happens inside micromark's own destination-URI sanitizer while building the
// AST, unconditionally, before react-markdown's component layer (and so
// resolveLink) ever sees the value. Verified empirically: rendering
// `[x](sub\evil.md)` through the real MarkdownContent delivers the href
// `'sub%5Cevil.md'` to resolveLink, never a literal backslash. That string
// contains no `..`, no leading `/` and no `\` character, so it is correctly
// treated as a safe, ordinary (if oddly named) relative path segment — there
// is no reachable real-world input that both contains a literal `\` and
// survives to resolveLink.
//
// So this is the one deliberate exception to the "real react-markdown, no
// mocks" convention used everywhere else in this feature's doc-viewer tests:
// MarkdownContent is mocked here purely to capture the real, unmodified
// resolveLink closure MarkdownViewer builds, so it can be called directly
// with a raw backslash — unit-testing the defense-in-depth check itself,
// independent of whether any current markdown-syntax input can trigger it.
// ---------------------------------------------------------------------------

const captured = vi.hoisted(() => ({
  resolveLink: null as ((href: string) => (() => void) | null) | null,
}))

vi.mock('../../../renderer/components/docviewer/MarkdownContent', () => ({
  MarkdownContent: (props: { resolveLink?: (href: string) => (() => void) | null }) => {
    captured.resolveLink = props.resolveLink ?? null
    return null
  },
}))

const mockDocViewerState = vi.hoisted(() => ({
  file: { filePath: '/docs/notes/readme.md', content: '' },
  fileLoading: false,
  error: null as string | null,
  openedFromFolder: false,
  navigateBack: vi.fn(),
  retry: vi.fn(),
  openFile: vi.fn(),
  workspaceSlug: 'ws1' as string | null,
}))

vi.mock('../../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: (selector: (s: typeof mockDocViewerState) => unknown) => selector(mockDocViewerState),
}))

vi.mock('../../../renderer/hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => (action: () => void) => action(),
}))

import { MarkdownViewer } from '../../../renderer/components/docviewer/MarkdownViewer'

describe('MarkdownViewer — resolveLink rejects a literal backslash (Fix #115)', () => {
  it('an href containing a backslash is not resolved', () => {
    render(<MarkdownViewer />)
    expect(captured.resolveLink).toBeTypeOf('function')
    const onOpen = captured.resolveLink!('sub\\evil.md')
    expect(onOpen).toBeNull()
    expect(mockDocViewerState.openFile).not.toHaveBeenCalled()
  })

  it('control: the same href with a forward slash instead IS resolved', () => {
    render(<MarkdownViewer />)
    const onOpen = captured.resolveLink!('sub/evil.md')
    expect(onOpen).not.toBeNull()
  })
})
