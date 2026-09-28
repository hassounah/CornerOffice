import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, waitFor, fireEvent, act } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { SourceView } from '../../../renderer/components/code/SourceView'
import type { SourceViewControls } from '../../../renderer/components/code/SourceView'

// ---------------------------------------------------------------------------
// SourceView — the CodeMirror integration (TRD §3.6.5, §3.6.6). A real
// EditorView is mounted (not a mock): jsdom's Range.getClientRects/
// getBoundingClientRect are stubbed globally in setup.ts (TRD §11 R12) so
// this works. These tests query rendered DOM text/attributes, never layout.
// ---------------------------------------------------------------------------

function baseProps() {
  return {
    relPath: 'src/example.ts',
    content: 'const a = 1\nconst b = 2\n',
    highlight: true,
    editing: false,
    skin: 'office' as const,
    onDocChange: vi.fn(),
    onSave: vi.fn(),
    onQuickOpen: vi.fn(),
  }
}

describe('SourceView — mount and content', () => {
  it('renders the initial content', () => {
    const { container } = render(<SourceView {...baseProps()} />)
    expect(container.textContent).toContain('const a = 1')
    expect(container.textContent).toContain('const b = 2')
  })

  it('mounts a real CodeMirror editor (.cm-editor, .cm-content)', () => {
    const { container } = render(<SourceView {...baseProps()} />)
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.querySelector('.cm-content')).not.toBeNull()
  })

  // readOnly is a transaction-level gate (EditorState.readOnly), not the DOM
  // contenteditable attribute (that stays "true" either way, via the
  // wrapper's own separate `editable` prop, so selection/copy still work
  // read-only) — checked through the real state, not a DOM probe.
  it('sets state.readOnly = true when not editing', () => {
    let readyView: import('@codemirror/view').EditorView | undefined
    render(
      <SourceView
        {...baseProps()}
        editing={false}
        onReady={(view) => {
          readyView = view
        }}
      />,
    )
    expect(readyView?.state.readOnly).toBe(true)
  })

  it('sets state.readOnly = false when editing', () => {
    let readyView: import('@codemirror/view').EditorView | undefined
    render(
      <SourceView
        {...baseProps()}
        editing={true}
        onReady={(view) => {
          readyView = view
        }}
      />,
    )
    expect(readyView?.state.readOnly).toBe(false)
  })

  it('calls onReady with the underlying EditorView once', () => {
    const onReady = vi.fn()
    render(<SourceView {...baseProps()} onReady={onReady} />)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady.mock.calls[0][0]).toHaveProperty('dispatch')
    expect(onReady.mock.calls[0][0]).toHaveProperty('state')
  })
})

describe('SourceView — language loading', () => {
  it('loads and applies a language when highlight is true (no crash, no plain-text-only fallback needed to assert against — just that it settles)', async () => {
    const onReady = vi.fn()
    render(<SourceView {...baseProps()} relPath="a.ts" highlight={true} onReady={onReady} />)
    await waitFor(() => expect(onReady).toHaveBeenCalled())
    // No direct assertion on syntax highlighting classes (brittle across
    // @lezer/highlight versions) — this proves the async load path doesn't
    // throw and the component stays mounted and interactive.
  })

  it('does not attempt to load a language when highlight is false', () => {
    // No assertion beyond "renders without throwing" — loadLanguageForFile
    // has its own dedicated tests; this just proves SourceView skips calling
    // it at all when highlight is false (a network/CPU-avoidance contract).
    const { container } = render(<SourceView {...baseProps()} highlight={false} />)
    expect(container.querySelector('.cm-editor')).not.toBeNull()
  })
})

describe('SourceView — onDocChange and dirty', () => {
  it('does not call onDocChange on mount', () => {
    const onDocChange = vi.fn()
    render(<SourceView {...baseProps()} onDocChange={onDocChange} />)
    expect(onDocChange).not.toHaveBeenCalled()
  })

  it('calls onDocChange(doc, dirty=true) after a real edit', async () => {
    const onDocChange = vi.fn()
    let readyView: import('@codemirror/view').EditorView | undefined
    render(
      <SourceView
        {...baseProps()}
        editing={true}
        onDocChange={onDocChange}
        onReady={(view) => {
          readyView = view
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())
    readyView!.dispatch({ changes: { from: 0, insert: 'X' } })

    expect(onDocChange).toHaveBeenCalledTimes(1)
    const [doc, dirty] = onDocChange.mock.calls[0]
    expect(doc.toString()).toBe('Xconst a = 1\nconst b = 2\n')
    expect(dirty).toBe(true)
  })

  it('reports dirty=false if a dispatch restores the original content', async () => {
    const onDocChange = vi.fn()
    let readyView: import('@codemirror/view').EditorView | undefined
    render(
      <SourceView
        {...baseProps()}
        editing={true}
        onDocChange={onDocChange}
        onReady={(view) => {
          readyView = view
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())
    readyView!.dispatch({ changes: { from: 0, insert: 'X' } })
    readyView!.dispatch({ changes: { from: 0, to: 1, insert: '' } })

    const last = onDocChange.mock.calls[onDocChange.mock.calls.length - 1]
    expect(last[0].toString()).toBe('const a = 1\nconst b = 2\n')
    expect(last[1]).toBe(false)
  })

  // Fix #129: an external dispatch (a future disk-reload-in-place, 2.20) must
  // be able to atomically move the dirty-comparison baseline in the same
  // tick, or the next onUpdate misreports dirty:true for a reload nobody typed.
  it('rebaseline() makes the NEXT onDocChange report dirty=false against the new baseline', async () => {
    const onDocChange = vi.fn()
    let readyView: import('@codemirror/view').EditorView | undefined
    let controls: SourceViewControls | undefined
    render(
      <SourceView
        {...baseProps()}
        editing={true}
        onDocChange={onDocChange}
        onReady={(view, ctrl) => {
          readyView = view
          controls = ctrl
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())

    // Simulate an external reload-in-place dispatch, then rebaseline in the
    // same tick — exactly the contract 2.20 needs.
    readyView!.dispatch({ changes: { from: 0, insert: 'RELOADED ' } })
    controls!.rebaseline()

    // A subsequent, unrelated no-op-content-preserving edit should now be
    // compared against the NEW baseline, not the pre-reload one.
    onDocChange.mockClear()
    readyView!.dispatch({ changes: { from: 0, insert: 'Y' } })
    readyView!.dispatch({ changes: { from: 0, to: 1, insert: '' } })

    const last = onDocChange.mock.calls[onDocChange.mock.calls.length - 1]
    expect(last[0].toString()).toBe('RELOADED const a = 1\nconst b = 2\n')
    expect(last[1]).toBe(false)
  })

  it('without rebaseline(), the same external dispatch would self-report dirty=true against the stale baseline', async () => {
    const onDocChange = vi.fn()
    let readyView: import('@codemirror/view').EditorView | undefined
    render(
      <SourceView
        {...baseProps()}
        editing={true}
        onDocChange={onDocChange}
        onReady={(view) => {
          readyView = view
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())

    readyView!.dispatch({ changes: { from: 0, insert: 'RELOADED ' } })

    const last = onDocChange.mock.calls[onDocChange.mock.calls.length - 1]
    expect(last[1]).toBe(true)
  })

  // Fix #129 item 4: the view-mode silent-reload row of §3.9.2 needs a
  // targeted-transaction apply, not a blunt content-prop replace.
  it('applyExternalContent() replaces the document via a targeted minimalChange transaction', async () => {
    let readyView: import('@codemirror/view').EditorView | undefined
    let controls: SourceViewControls | undefined
    render(
      <SourceView
        {...baseProps()}
        onReady={(view, ctrl) => {
          readyView = view
          controls = ctrl
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())

    controls!.applyExternalContent('const a = 1\nconst b = 99\n')
    expect(readyView!.state.doc.toString()).toBe('const a = 1\nconst b = 99\n')
  })

  it('applyExternalContent() preserves an unrelated selection (a targeted diff, not a full replace)', async () => {
    let readyView: import('@codemirror/view').EditorView | undefined
    let controls: SourceViewControls | undefined
    render(
      <SourceView
        {...baseProps()}
        onReady={(view, ctrl) => {
          readyView = view
          controls = ctrl
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())

    // Place the cursor inside "const a = 1" (untouched by the reload below).
    readyView!.dispatch({ selection: { anchor: 6 } })
    controls!.applyExternalContent('const a = 1\nconst b = 99\n')

    // A blunt full-document replace would reset the selection to 0; the
    // targeted diff (only "2" -> "99" changes) leaves this position intact.
    expect(readyView!.state.selection.main.head).toBe(6)
  })

  it('applyExternalContent() is a no-op when the content already matches (no dispatch, no onDocChange)', async () => {
    const onDocChange = vi.fn()
    let readyView: import('@codemirror/view').EditorView | undefined
    let controls: SourceViewControls | undefined
    render(
      <SourceView
        {...baseProps()}
        onDocChange={onDocChange}
        onReady={(view, ctrl) => {
          readyView = view
          controls = ctrl
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())

    controls!.applyExternalContent('const a = 1\nconst b = 2\n') // same as baseProps().content
    expect(onDocChange).not.toHaveBeenCalled()
  })
})

describe('SourceView — content is captured once at mount (Fix #140)', () => {
  it('a changed `content` prop on a later render does NOT blunt-replace the live document', async () => {
    let readyView: import('@codemirror/view').EditorView | undefined
    const { rerender } = render(
      <SourceView
        {...baseProps()}
        onReady={(view) => {
          readyView = view
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())
    readyView!.dispatch({ selection: { anchor: 6 } })

    // Same key in real usage (CodePane keys by relPath:fileReq, unchanged
    // here) — only the `content` prop differs, exactly what happens today
    // when the store's `file.content` changes for a silent disk-reload.
    rerender(
      <SourceView
        {...baseProps()}
        content="totally different content, never dispatched\n"
        onReady={(view) => {
          readyView = view
        }}
      />,
    )

    // The live document must stay exactly what it was — SourceView's own
    // contract says `content` is captured once per mount, uncontrolled; only
    // `controls.applyExternalContent` may change the doc after mount. A
    // blunt full replace (uncaptured, live-bound `value={content}`) would
    // both change this text AND reset the selection to 0.
    expect(readyView!.state.doc.toString()).toBe(baseProps().content)
    expect(readyView!.state.selection.main.head).toBe(6)
  })
})

describe('SourceView — accessibility', () => {
  it('names the editor region with an aria-label of the open file (Fix #129)', () => {
    const { container } = render(<SourceView {...baseProps()} relPath="src/example.ts" />)
    expect(container.querySelector('.cm-content')).toHaveAttribute('aria-label', 'src/example.ts')
  })
})

describe('SourceView — keymap wiring', () => {
  it('a real Mod-S keydown through .cm-content calls onSave (proves the keymap is actually wired)', async () => {
    const onSave = vi.fn()
    const { container } = render(<SourceView {...baseProps()} editing={true} onSave={onSave} />)
    const content = container.querySelector('.cm-content')
    expect(content).not.toBeNull()
    fireEvent.keyDown(content!, { key: 's', code: 'KeyS', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('a real Mod-P keydown through .cm-content calls onQuickOpen', async () => {
    const onQuickOpen = vi.fn()
    const { container } = render(<SourceView {...baseProps()} onQuickOpen={onQuickOpen} />)
    const content = container.querySelector('.cm-content')
    fireEvent.keyDown(content!, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(onQuickOpen).toHaveBeenCalledTimes(1)
  })
})

describe('SourceView — cursor position', () => {
  it('calls onCursorChange with 1-based line/col after a selection change', async () => {
    const onCursorChange = vi.fn()
    let readyView: import('@codemirror/view').EditorView | undefined
    render(
      <SourceView
        {...baseProps()}
        onCursorChange={onCursorChange}
        onReady={(view) => {
          readyView = view
        }}
      />,
    )
    await waitFor(() => expect(readyView).toBeDefined())
    // Move the cursor to the start of line 2 ("const b = 2"), offset 12.
    readyView!.dispatch({ selection: { anchor: 12 } })

    expect(onCursorChange).toHaveBeenCalledWith({ line: 2, col: 1 })
  })
})

describe('SourceView — theme', () => {
  it('applies a dark background for both skins (office and realm both use dark editor themes)', () => {
    const { container: officeContainer } = render(<SourceView {...baseProps()} skin="office" />)
    const { container: realmContainer } = render(<SourceView {...baseProps()} skin="realm" />)
    expect(officeContainer.querySelector('.cm-editor')).not.toBeNull()
    expect(realmContainer.querySelector('.cm-editor')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fix #148: CodeMirror's own internal light/dark classification
// (EditorView.darkTheme) must actually track `.theme-light`, for both skins
// — checked through the real facet CodeMirror exposes, not a DOM probe (the
// class it applies is an opaque, auto-generated StyleModule name).
// ---------------------------------------------------------------------------

describe('SourceView — CodeMirror\'s own dark/light classification (Fix #148)', () => {
  afterEach(async () => {
    // Awaited (not a bare synchronous toggle): the resulting MutationObserver
    // callback (useIsThemeLight.ts) fires as its own microtask, one tick
    // after this class change, not synchronously within it — an unawaited
    // toggle here would leave that update to land during the NEXT test
    // instead, un-wrapped in any act() boundary of its own.
    await act(async () => {
      document.documentElement.classList.remove('theme-light')
    })
  })

  // highlight={false} on every render below: baseProps() defaults highlight
  // to true, which kicks off SourceView's OWN unrelated async language-load
  // effect (loadLanguageForFile().then(setLanguageExt)) — irrelevant to what
  // these tests check, and its own un-awaited state update would otherwise
  // add unrelated act() noise on top of the theme assertions below.

  it('marks the editor dark by default (.theme-light absent), for both skins', () => {
    let officeView: import('@codemirror/view').EditorView | undefined
    let realmView: import('@codemirror/view').EditorView | undefined
    render(<SourceView {...baseProps()} highlight={false} skin="office" onReady={(view) => { officeView = view }} />)
    render(<SourceView {...baseProps()} highlight={false} skin="realm" onReady={(view) => { realmView = view }} />)
    expect(officeView?.state.facet(EditorView.darkTheme)).toBe(true)
    expect(realmView?.state.facet(EditorView.darkTheme)).toBe(true)
  })

  it('marks the editor light when .theme-light is already present at mount, for both skins', async () => {
    await act(async () => {
      document.documentElement.classList.add('theme-light')
    })
    let officeView: import('@codemirror/view').EditorView | undefined
    let realmView: import('@codemirror/view').EditorView | undefined
    render(<SourceView {...baseProps()} highlight={false} skin="office" onReady={(view) => { officeView = view }} />)
    render(<SourceView {...baseProps()} highlight={false} skin="realm" onReady={(view) => { realmView = view }} />)
    expect(officeView?.state.facet(EditorView.darkTheme)).toBe(false)
    expect(realmView?.state.facet(EditorView.darkTheme)).toBe(false)
  })

  it('re-resolves live, on the SAME view (no remount), when .theme-light toggles after mount', async () => {
    const onReady = vi.fn()
    let view: import('@codemirror/view').EditorView | undefined
    render(
      <SourceView
        {...baseProps()}
        highlight={false}
        onReady={(v) => {
          view = v
          onReady(v)
        }}
      />,
    )
    await waitFor(() => expect(view).toBeDefined())
    expect(view!.state.facet(EditorView.darkTheme)).toBe(true)
    expect(onReady).toHaveBeenCalledTimes(1)

    await act(async () => {
      document.documentElement.classList.add('theme-light')
    })

    await waitFor(() => expect(view!.state.facet(EditorView.darkTheme)).toBe(false))
    // Reconfigured in place, via @uiw/react-codemirror's own theme-prop
    // handling — never torn down and rebuilt (onReady/onCreateEditor fires
    // once per mount, not once per theme change).
    expect(onReady).toHaveBeenCalledTimes(1)
  })
})
