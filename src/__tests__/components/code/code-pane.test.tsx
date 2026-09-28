import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { CodePane } from '../../../renderer/components/code/CodePane'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import type { CodeFileResponse } from '@main/types/code'

// ---------------------------------------------------------------------------
// CodePane — the content pane (TRD §3.6.4, FR-14–FR-17; Sec H-3). Reuses the
// store-mocking convention established for FileTree/ExplorerToolbar/
// FileHeader. SourceView (2.16) mounts a real CodeMirror EditorView — jsdom's
// Range.getClientRects/getBoundingClientRect stub (setup.ts, TRD §11 R12)
// already covers that globally.
// ---------------------------------------------------------------------------

// DiffView review note 5 / §3.9.2 wiring: verifies CodePane withholds
// `highlight` (skipping async language loading entirely) whenever the
// baseline side is a card kind (secret/binary/too-large/unavailable) that
// DiffView will never actually syntax-highlight. A real, never-resolving
// mock so its call count is the only thing under test — timing doesn't
// matter since DiffView's language effect is fire-and-forget.
const mockLoadLanguageForFile = vi.fn(() => new Promise<null>(() => {}))
vi.mock('../../../renderer/components/code/cm/languages', () => ({
  loadLanguageForFile: () => mockLoadLanguageForFile(),
}))

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  mockLoadLanguageForFile.mockClear()
})

function textFile(overrides: Partial<Extract<CodeFileResponse, { kind: 'text' }>> = {}): CodeFileResponse {
  return {
    kind: 'text',
    relPath: 'docs/README.md',
    name: 'README.md',
    size: 42,
    lastModified: new Date().toISOString(),
    content: '# Hello\n\n[link](other.md)\n',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    highlight: true,
    editable: true,
    readOnlyReason: null,
    previewable: null,
    ...overrides,
  }
}

function seed(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}) {
  useCodeExplorerStore.setState({
    open: true,
    workspaceSlug: 'test-ws',
    selected: 'docs/README.md',
    ...overrides,
  })
}

function renderPane(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}) {
  const onQuickOpen = vi.fn()
  seed(overrides)
  const utils = render(<CodePane skin="office" onQuickOpen={onQuickOpen} />)
  return { ...utils, onQuickOpen }
}

describe('CodePane — session states', () => {
  it('renders nothing when no file is selected', () => {
    const { container } = renderPane({ selected: null })
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a loading state', () => {
    renderPane({ fileLoading: true, file: null })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows the friendly error message on fileError', () => {
    renderPane({ fileError: { code: 'NOT_FOUND', message: 'File not found' } })
    expect(screen.getByText('File not found')).toBeInTheDocument()
  })

  it('announces fileError via role="alert", not a silent plain div (Fix #133 item 1)', () => {
    renderPane({ fileError: { code: 'NOT_FOUND', message: 'File not found' } })
    expect(screen.getByRole('alert')).toHaveTextContent('File not found')
  })

  it('renders nothing when a file is selected but neither loading, errored, nor loaded yet (defensive fallback)', () => {
    const { container } = renderPane({ file: null, fileLoading: false, fileError: null })
    expect(container).toBeEmptyDOMElement()
  })
})

describe('CodePane — secret (unrevealed)', () => {
  it('shows the secret notice with a Reveal action', () => {
    renderPane({
      file: { kind: 'secret', relPath: '.env', name: '.env', size: 10, lastModified: '' },
      revealed: false,
    })
    expect(screen.getByText('This file may contain secrets. Contents hidden.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument()
  })

  it('clicking Reveal calls reveal()', () => {
    const reveal = vi.fn()
    renderPane({
      file: { kind: 'secret', relPath: '.env', name: '.env', size: 10, lastModified: '' },
      revealed: false,
      reveal,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('hides the Reveal action once revealed is true (reveal already in flight or done)', () => {
    renderPane({
      file: { kind: 'secret', relPath: '.env', name: '.env', size: 10, lastModified: '' },
      revealed: true,
    })
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull()
  })
})

describe('CodePane — too-large', () => {
  it('shows "Too large to display (N MB)"', () => {
    renderPane({
      file: { kind: 'too-large', relPath: 'big.bin', name: 'big.bin', size: 15 * 1024 * 1024, lastModified: '' },
    })
    expect(screen.getByText('Too large to display (15 MB)')).toBeInTheDocument()
  })

  it('announces itself via role="status" (Fix #133 item 1)', () => {
    renderPane({
      file: { kind: 'too-large', relPath: 'big.bin', name: 'big.bin', size: 15 * 1024 * 1024, lastModified: '' },
    })
    expect(screen.getByRole('status')).toHaveTextContent('Too large to display (15 MB)')
  })
})

describe('CodePane — binary', () => {
  it('shows an info card with mime type and size', () => {
    renderPane({
      file: { kind: 'binary', relPath: 'a.exe', name: 'a.exe', size: 2048, mime: 'application/x-executable', lastModified: '' },
    })
    expect(screen.getByText('application/x-executable')).toBeInTheDocument()
    expect(screen.getByText('2,048 bytes')).toBeInTheDocument()
  })

  it('falls back to "Binary file" when mime is null', () => {
    renderPane({ file: { kind: 'binary', relPath: 'a.bin', name: 'a.bin', size: 1, mime: null, lastModified: '' } })
    expect(screen.getByText('Binary file')).toBeInTheDocument()
  })

  it('announces itself via role="status" (Fix #133 item 1)', () => {
    renderPane({
      file: { kind: 'binary', relPath: 'a.exe', name: 'a.exe', size: 2048, mime: 'application/x-executable', lastModified: '' },
    })
    expect(screen.getByRole('status')).toHaveTextContent('application/x-executable')
  })
})

describe('CodePane — image', () => {
  it('renders an <img> and the file size', () => {
    renderPane({
      file: {
        kind: 'image', relPath: 'pic.png', name: 'pic.png', size: 1234,
        mime: 'image/png', dataBase64: 'AAAA', lastModified: '',
      },
    })
    const img = screen.getByRole('img', { name: 'pic.png' })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(screen.getByText('1,234 bytes')).toBeInTheDocument()
  })

  it('shows dimensions once the image reports its natural size', () => {
    renderPane({
      file: {
        kind: 'image', relPath: 'pic.png', name: 'pic.png', size: 1234,
        mime: 'image/png', dataBase64: 'AAAA', lastModified: '',
      },
    })
    const img = screen.getByRole('img', { name: 'pic.png' }) as HTMLImageElement
    Object.defineProperty(img, 'naturalWidth', { value: 640, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 480, configurable: true })
    fireEvent.load(img)
    expect(screen.getByText(/640 × 480/)).toBeInTheDocument()
  })

  it('announces a landing status alongside the image (Fix #133 item 1)', () => {
    renderPane({
      file: {
        kind: 'image', relPath: 'pic.png', name: 'pic.png', size: 1234,
        mime: 'image/png', dataBase64: 'AAAA', lastModified: '',
      },
    })
    expect(screen.getByRole('status')).toHaveTextContent('Image preview: pic.png')
  })

  it('the alt text goes through tokenizeNameToText, not the raw name (Fix #133 item 2)', () => {
    const bidi = String.fromCharCode(0x202e) // RTL override
    renderPane({
      file: {
        kind: 'image', relPath: `${bidi}.png`, name: `${bidi}.png`, size: 1234,
        mime: 'image/png', dataBase64: 'AAAA', lastModified: '',
      },
    })
    const img = document.querySelector('img')!
    expect(img.getAttribute('alt')).not.toContain(bidi)
    // The status announcement carries the same tokenized name too.
    expect(screen.getByRole('status').textContent).not.toContain(bidi)
  })

  it('shows a fallback notice instead of a broken image on load failure (Fix #133 item 3)', () => {
    renderPane({
      file: {
        kind: 'image', relPath: 'pic.png', name: 'pic.png', size: 1234,
        mime: 'image/png', dataBase64: 'AAAA', lastModified: '',
      },
    })
    const img = screen.getByRole('img', { name: 'pic.png' })
    fireEvent.error(img)
    expect(screen.queryByRole('img', { name: 'pic.png' })).toBeNull()
    expect(screen.getByText("Couldn't load image preview")).toBeInTheDocument()
  })

  it('associates the dimensions/size caption with the <img> via aria-describedby (Fix #133 item 4)', () => {
    renderPane({
      file: {
        kind: 'image', relPath: 'pic.png', name: 'pic.png', size: 1234,
        mime: 'image/png', dataBase64: 'AAAA', lastModified: '',
      },
    })
    const img = screen.getByRole('img', { name: 'pic.png' })
    const describedBy = img.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const caption = document.getElementById(describedBy!)
    expect(caption).not.toBeNull()
    expect(caption!.textContent).toContain('1,234 bytes')
    expect(caption!.tagName).toBe('FIGCAPTION')
    expect(img.closest('figure')).not.toBeNull()
  })
})

describe('CodePane — text: Source view', () => {
  it('renders SourceView (a real CodeMirror editor) and the StatusBar', () => {
    renderPane({ file: textFile(), view: 'source' })
    expect(document.querySelector('.cm-editor')).not.toBeNull()
    expect(screen.getByText('UTF-8')).toBeInTheDocument()
    expect(screen.getByText('LF')).toBeInTheDocument()
  })

  it('shows the read-only notice when the file has a readOnlyReason', () => {
    renderPane({ file: textFile({ editable: false, readOnlyReason: 'mixed-eol' }), view: 'source' })
    expect(screen.getByText('Opened read-only: mixed line endings')).toBeInTheDocument()
  })

  it('shows no read-only notice when the file is editable', () => {
    renderPane({ file: textFile({ editable: true, readOnlyReason: null }), view: 'source' })
    expect(screen.queryByText(/Opened read-only/)).toBeNull()
  })

  it('wires SourceView\'s Mod-S keybinding to the store\'s save()', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    renderPane({ file: textFile(), editing: true, view: 'source', save })
    const content = document.querySelector('.cm-content')
    expect(content).not.toBeNull()
    fireEvent.keyDown(content!, { key: 's', code: 'KeyS', ctrlKey: true })
    expect(save).toHaveBeenCalledTimes(1)
  })

  // §3.9.2's two SILENT disk-change rows. handleDiskChangeDetected updates
  // the store's `file` WITHOUT bumping `fileReq` for these rows specifically
  // (a real reload — reloadFromDisk, a file switch — always bumps it and
  // remounts SourceView via its key instead) — so SourceView, being
  // deliberately uncontrolled, would never reflect the change without
  // CodePane bridging it through SourceViewControls (Fix #129).
  describe('live disk-change pushes via SourceViewControls', () => {
    it('view mode: a same-key content change appears in the live editor (no remount)', () => {
      const { container } = renderPane({
        file: textFile({ content: 'one\ntwo\nthree\n' }),
        view: 'source',
        editing: false,
      })
      expect(container.textContent).toContain('two')

      act(() => {
        useCodeExplorerStore.setState({ file: textFile({ content: 'one\nTWO\nthree\n' }) })
      })
      expect(container.textContent).toContain('TWO')
    })

    it('editing ∧ clean: a same-key content change appears live AND rebaselines, so dirty stays false', () => {
      const { container } = renderPane({
        file: textFile({ content: 'one\ntwo\nthree\n' }),
        view: 'source',
        editing: true,
        dirty: false,
      })

      act(() => {
        useCodeExplorerStore.setState({ file: textFile({ content: 'one\nTWO\nthree\n' }) })
      })
      expect(container.textContent).toContain('TWO')
      // Without controls.rebaseline() in the same tick, the dispatch above
      // would make SourceView's own dirty comparison see a doc that no
      // longer matches its stale pre-reload baseline, misreporting a reload
      // nobody typed as an unsaved edit.
      expect(useCodeExplorerStore.getState().dirty).toBe(false)
    })

    // Fix #140: the tests above only check `container.textContent`, which a
    // BLUNT full-document replace (via @uiw/react-codemirror's own value-
    // diffing reacting to the `content` prop changing) would satisfy just as
    // well as the targeted `applyExternalContent` dispatch — textContent
    // can't tell the two apart. Only the live selection/cursor position can:
    // a blunt replace resets it to 0, a targeted diff leaves an untouched
    // position alone. `EditorView.findFromDOM` recovers the real, live view
    // CodePane's own `onReady` captured internally, with no test-only prop.
    it('view mode: the disk-reload preserves the live selection (proves a targeted diff, not a blunt replace)', async () => {
      renderPane({ file: textFile({ content: 'one\ntwo\nthree\n' }), view: 'source', editing: false })
      const view = await waitFor(() => {
        const found = EditorView.findFromDOM(document.querySelector('.cm-content')!)
        expect(found).not.toBeNull()
        return found!
      })
      // Position 1 is inside "one" (offsets 0-2), entirely untouched by the
      // "two" -> "TWO" edit at offsets 4-7 below — same reasoning as
      // source-view.test.tsx's own equivalent unit test.
      view.dispatch({ selection: { anchor: 1 } })

      act(() => {
        useCodeExplorerStore.setState({ file: textFile({ content: 'one\nTWO\nthree\n' }) })
      })

      expect(view.state.doc.toString()).toBe('one\nTWO\nthree\n')
      expect(view.state.selection.main.head).toBe(1)
    })

    it('editing ∧ clean: the disk-reload preserves the live selection too', async () => {
      renderPane({ file: textFile({ content: 'one\ntwo\nthree\n' }), view: 'source', editing: true, dirty: false })
      const view = await waitFor(() => {
        const found = EditorView.findFromDOM(document.querySelector('.cm-content')!)
        expect(found).not.toBeNull()
        return found!
      })
      view.dispatch({ selection: { anchor: 1 } })

      act(() => {
        useCodeExplorerStore.setState({ file: textFile({ content: 'one\nTWO\nthree\n' }) })
      })

      expect(view.state.doc.toString()).toBe('one\nTWO\nthree\n')
      expect(view.state.selection.main.head).toBe(1)
      expect(useCodeExplorerStore.getState().dirty).toBe(false)
    })

    it('a genuine remount (fileReq bump) is not mistaken for a live push — no double-apply', () => {
      const { container } = renderPane({
        selected: 'a.ts',
        file: textFile({ relPath: 'a.ts', content: 'first file\n' }),
        view: 'source',
        fileReq: 1,
      })
      expect(container.textContent).toContain('first file')

      act(() => {
        useCodeExplorerStore.setState({
          selected: 'b.ts',
          file: textFile({ relPath: 'b.ts', content: 'second file\n' }),
          fileReq: 2,
        })
      })
      expect(container.textContent).toContain('second file')
      expect(container.textContent).not.toContain('first file')
    })
  })
})

describe('CodePane — text: Preview', () => {
  it('renders MarkdownContent for previewable: markdown', () => {
    renderPane({ file: textFile({ previewable: 'markdown', content: '# Hello world' }), view: 'preview' })
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('renders YamlContent for previewable: yaml', () => {
    renderPane({ file: textFile({ previewable: 'yaml', content: 'key: value' }), view: 'preview' })
    expect(screen.getByText('key')).toBeInTheDocument()
    expect(screen.getByText('value')).toBeInTheDocument()
  })

  it('renders an <img data:> for previewable: svg', () => {
    renderPane({
      file: textFile({ relPath: 'icon.svg', name: 'icon.svg', previewable: 'svg', content: '<svg></svg>' }),
      view: 'preview',
    })
    const img = screen.getByRole('img', { name: 'icon.svg' })
    expect(img.getAttribute('src')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E')
  })

  it('SVG preview alt text goes through tokenizeNameToText, not the raw name (Fix #133 item 2)', () => {
    const bidi = String.fromCharCode(0x202e) // RTL override
    renderPane({
      file: textFile({ relPath: `${bidi}.svg`, name: `${bidi}.svg`, previewable: 'svg', content: '<svg></svg>' }),
      view: 'preview',
    })
    const img = document.querySelector('img')!
    expect(img.getAttribute('alt')).not.toContain(bidi)
  })
})

describe('CodePane — text: Changes view (DiffView, 2.18/2.20 wiring)', () => {
  it('shows a loading placeholder for view = changes before baselineDoc arrives', () => {
    renderPane({ file: textFile(), view: 'changes', baselineDoc: null })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders the real DiffView once baselineDoc has loaded', () => {
    const { container } = renderPane({
      file: textFile({ content: 'one\nTWO\nthree\n', highlight: false }),
      view: 'changes',
      baselineDoc: { kind: 'text', content: 'one\ntwo\nthree\n', eol: 'lf', bom: false, encoding: 'utf-8' },
    })
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.textContent).toContain('TWO')
  })

  // §3.7.2 row 14 ("Render branches"): the Changes branch's DiffView must
  // route its own Reveal action through the store's `reveal`, same as every
  // other branch's buttons (the secret-kind branch above already covers
  // that for the non-diff case).
  it('wires DiffView\'s onReveal to the store\'s reveal()', () => {
    const reveal = vi.fn()
    renderPane({
      file: textFile(),
      view: 'changes',
      revealed: false,
      reveal,
      baselineDoc: { kind: 'secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  // §3.9.1's deleted-change row (FR-9): a changed file whose git status is
  // 'deleted' never has content — `file` stays null forever for it
  // (openFile's NOT_FOUND short-circuit) — routes straight to DiffView with
  // the synthetic `{kind:'deleted'}` current side, showing removed content.
  it('routes a deleted change (file never loaded) straight to DiffView with removed content', () => {
    const { container } = renderPane({
      file: null,
      fileLoading: false,
      fileError: null,
      selected: 'gone.ts',
      deletedPath: 'gone.ts',
      view: 'changes',
      baselineDoc: { kind: 'text', content: 'old content\n', eol: 'lf', bom: false, encoding: 'utf-8' },
    })
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.textContent).toContain('old content')
  })

  it('shows a loading placeholder for the deleted-change case before baselineDoc arrives', () => {
    renderPane({
      file: null,
      fileLoading: false,
      fileError: null,
      selected: 'gone.ts',
      deletedPath: 'gone.ts',
      view: 'changes',
      baselineDoc: null,
    })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})

// DiffView review note 5 (§3.9.2): the language extension is loaded
// unconditionally by DiffView whenever `highlight` is true, even for a side
// that will only ever render as a plain notice card (a card branch never
// references the language extension) — pure waste. CodePane is the one
// caller that KNOWS the baseline's classified kind ahead of time, so it's
// the right place to withhold `highlight` for the four card kinds.
describe('CodePane — DiffView highlight gating (baseline card kinds skip language loading)', () => {
  it.each(['secret', 'unavailable'] as const)('withholds highlight when the baseline is %s', (kind) => {
    renderPane({ file: textFile(), view: 'changes', baselineDoc: { kind } })
    expect(mockLoadLanguageForFile).not.toHaveBeenCalled()
  })

  it('withholds highlight when the baseline is binary', () => {
    renderPane({ file: textFile(), view: 'changes', baselineDoc: { kind: 'binary', size: 10 } })
    expect(mockLoadLanguageForFile).not.toHaveBeenCalled()
  })

  it('withholds highlight when the baseline is too-large', () => {
    renderPane({ file: textFile(), view: 'changes', baselineDoc: { kind: 'too-large', size: 999 } })
    expect(mockLoadLanguageForFile).not.toHaveBeenCalled()
  })

  it('loads a language when the baseline is real text and the file wants highlighting', () => {
    renderPane({
      file: textFile({ highlight: true }),
      view: 'changes',
      baselineDoc: { kind: 'text', content: 'x', eol: 'lf', bom: false, encoding: 'utf-8' },
    })
    expect(mockLoadLanguageForFile).toHaveBeenCalled()
  })

  it('loads a language when the baseline is absent (an added file, still a real diff)', () => {
    renderPane({ file: textFile({ highlight: true }), view: 'changes', baselineDoc: { kind: 'absent' } })
    expect(mockLoadLanguageForFile).toHaveBeenCalled()
  })

  it('still withholds highlight for a real-text baseline when the file itself is highlight:false', () => {
    renderPane({
      file: textFile({ highlight: false }),
      view: 'changes',
      baselineDoc: { kind: 'text', content: 'x', eol: 'lf', bom: false, encoding: 'utf-8' },
    })
    expect(mockLoadLanguageForFile).not.toHaveBeenCalled()
  })

  it('the deleted-change case (file never loaded) loads a language when the baseline is real text', () => {
    renderPane({
      file: null,
      fileLoading: false,
      fileError: null,
      selected: 'gone.ts',
      deletedPath: 'gone.ts',
      view: 'changes',
      baselineDoc: { kind: 'text', content: 'x', eol: 'lf', bom: false, encoding: 'utf-8' },
    })
    expect(mockLoadLanguageForFile).toHaveBeenCalled()
  })

  it('the deleted-change case withholds highlight when the baseline is itself secret', () => {
    renderPane({
      file: null,
      fileLoading: false,
      fileError: null,
      selected: 'gone.ts',
      deletedPath: 'gone.ts',
      view: 'changes',
      baselineDoc: { kind: 'secret' },
    })
    expect(mockLoadLanguageForFile).not.toHaveBeenCalled()
  })
})

describe('CodePane — Preview link resolution (Sec H-3)', () => {
  // §3.7.2 row 5 ("Markdown Preview relative link"): guarded, scoped to
  // ['code-explorer'] — same convention as FileTree's "activation is
  // guarded" tests (file-tree.test.tsx): drive the store's OWN registered
  // dirty source directly (editing && dirty) rather than mocking guardAction.
  it('clicking a relative link while dirty does not switch files immediately (guarded)', () => {
    const openFile = vi.fn()
    renderPane({
      file: textFile({ relPath: 'docs/README.md', previewable: 'markdown', content: '[other](other.md)' }),
      view: 'preview',
      openFile,
      editing: true,
      dirty: true,
    })
    fireEvent.click(screen.getByRole('link', { name: 'other' }))
    expect(openFile).not.toHaveBeenCalled()
  })

  it('a same-directory relative link renders as button[role="link"] and opens through the guard', () => {
    const openFile = vi.fn()
    renderPane({
      file: textFile({ relPath: 'docs/README.md', previewable: 'markdown', content: '[other](other.md)' }),
      view: 'preview',
      openFile,
    })
    const link = screen.getByRole('link', { name: 'other' })
    expect(link.tagName).toBe('BUTTON')
    fireEvent.click(link)
    expect(openFile).toHaveBeenCalledWith('docs/other.md')
  })

  it('a ../ link that stays within the repo resolves and opens', () => {
    const openFile = vi.fn()
    renderPane({
      file: textFile({ relPath: 'docs/sub/README.md', previewable: 'markdown', content: '[up](../other.md)' }),
      view: 'preview',
      openFile,
    })
    fireEvent.click(screen.getByRole('link', { name: 'up' }))
    expect(openFile).toHaveBeenCalledWith('docs/other.md')
  })

  it('file:///… renders as plain text (blocked by MarkdownContent itself), no href anywhere', () => {
    const { container } = renderPane({
      file: textFile({ previewable: 'markdown', content: '[bad](file:///etc/passwd)' }),
      view: 'preview',
    })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('bad')).toBeInTheDocument()
    expect(container.querySelectorAll('[href]')).toHaveLength(0)
  })

  it('javascript: renders as plain text, no href anywhere', () => {
    const { container } = renderPane({
      file: textFile({ previewable: 'markdown', content: '[bad](javascript:alert(1))' }),
      view: 'preview',
    })
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelectorAll('[href]')).toHaveLength(0)
  })

  it('a traversal attempt (../../x.md) that escapes the repo root renders as plain text', () => {
    const { container } = renderPane({
      file: textFile({ relPath: 'README.md', previewable: 'markdown', content: '[bad](../../etc/passwd)' }),
      view: 'preview',
    })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('bad')).toBeInTheDocument()
    expect(container.querySelectorAll('[href]')).toHaveLength(0)
  })
})
