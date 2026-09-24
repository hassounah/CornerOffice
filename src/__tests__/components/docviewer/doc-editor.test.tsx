import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock docviewer store
// ---------------------------------------------------------------------------

const mockSetDraft = vi.fn()

const mockStore: Record<string, unknown> = {
  file: {
    filePath: '/docs/readme.md',
    name: 'readme.md',
    extension: 'md',
    content: '# Hello',
    size: 7,
    lastModified: '2026-01-01T00:00:00.000Z',
  },
  draft: '# Hello',
  setDraft: mockSetDraft,
}

vi.mock('../../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: vi.fn((selector?: (s: typeof mockStore) => unknown) =>
    selector ? selector(mockStore) : mockStore,
  ),
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { DocEditor } from '../../../renderer/components/docviewer/DocEditor'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.draft = '# Hello'
    mockStore.file = {
      filePath: '/docs/readme.md',
      name: 'readme.md',
      extension: 'md',
      content: '# Hello',
      size: 7,
      lastModified: '2026-01-01T00:00:00.000Z',
    }
  })

  it('renders the current draft value in the textarea', () => {
    mockStore.draft = 'current draft content'
    render(<DocEditor />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('current draft content')
  })

  it('calls setDraft when the textarea changes', () => {
    render(<DocEditor />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'new content' } })
    expect(mockSetDraft).toHaveBeenCalledWith('new content')
    expect(mockSetDraft).toHaveBeenCalledTimes(1)
  })

  it('has a dynamic aria-label including the file name (§17 R17)', () => {
    render(<DocEditor />)
    const textarea = screen.getByRole('textbox')
    expect(textarea.getAttribute('aria-label')).toBe('Edit readme.md')
  })

  it('falls back to generic aria-label when file is null', () => {
    mockStore.file = null
    render(<DocEditor />)
    const textarea = screen.getByRole('textbox')
    expect(textarea.getAttribute('aria-label')).toBe('Edit document')
  })

  it('does NOT trap Tab key — no custom keydown handler on the textarea (§17 R17)', () => {
    render(<DocEditor />)
    const textarea = screen.getByRole('textbox')
    // The textarea must have no onKeyDown that overrides Tab behaviour.
    // Verify by firing Tab and confirming setDraft is not called (tab-insert would call it).
    fireEvent.keyDown(textarea, { key: 'Tab', code: 'Tab' })
    expect(mockSetDraft).not.toHaveBeenCalled()
  })

  it('renders an empty textarea when draft is empty string', () => {
    mockStore.draft = ''
    render(<DocEditor />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('is exported from the docviewer index', async () => {
    const mod = await import('../../../renderer/components/docviewer/index')
    expect(typeof mod.DocEditor).toBe('function')
  })
})
