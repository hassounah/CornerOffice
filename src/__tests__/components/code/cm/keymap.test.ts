import { describe, it, expect, vi, afterEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { sourceKeymap, diffKeymap } from '../../../../renderer/components/code/cm/keymap'

// The keymap is only meaningfully verifiable by actually dispatching keydown
// events at a real EditorView (CM6's own convention for testing keymaps) —
// there is no public API to introspect a built keymap Extension's bindings.

let view: EditorView | null = null

function makeView(callbacks: { onSave: () => void; onQuickOpen: () => void }, doc = 'hello world'): EditorView {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [sourceKeymap(callbacks)] }),
    parent: document.body,
  })
  return view
}

function dispatchKey(target: EditorView, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.contentDOM.dispatchEvent(event)
  return event
}

afterEach(() => {
  view?.destroy()
  view = null
})

describe('sourceKeymap', () => {
  it('Mod-s calls onSave and does not insert a character', () => {
    const onSave = vi.fn()
    const v = makeView({ onSave, onQuickOpen: vi.fn() })
    const event = dispatchKey(v, { key: 's', code: 'KeyS', ctrlKey: true })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(v.state.doc.toString()).toBe('hello world')
  })

  it('Mod-p calls onQuickOpen', () => {
    const onQuickOpen = vi.fn()
    const v = makeView({ onSave: vi.fn(), onQuickOpen })
    dispatchKey(v, { key: 'p', code: 'KeyP', ctrlKey: true })

    expect(onQuickOpen).toHaveBeenCalledTimes(1)
  })

  it('Mod-g opens the goto-line panel, overriding search default findNext', () => {
    const v = makeView({ onSave: vi.fn(), onQuickOpen: vi.fn() })
    const event = dispatchKey(v, { key: 'g', code: 'KeyG', ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(v.dom.querySelector('.cm-goto-line')).not.toBeNull()
    // Did NOT fall through to search's default findNext, which would have
    // opened a search panel instead of a goto-line dialog.
    expect(v.dom.querySelector('.cm-search')).toBeNull()
  })

  it('Mod-f opens the search panel', () => {
    const v = makeView({ onSave: vi.fn(), onQuickOpen: vi.fn() })
    const event = dispatchKey(v, { key: 'f', code: 'KeyF', ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(v.dom.querySelector('.cm-search')).not.toBeNull()
  })

  it('F3 is handled by the keymap (bound to findNext)', () => {
    const v = makeView({ onSave: vi.fn(), onQuickOpen: vi.fn() })
    const event = dispatchKey(v, { key: 'F3', code: 'F3' })
    expect(event.defaultPrevented).toBe(true)
  })

  it('Shift-F3 is handled by the keymap (bound to findPrevious)', () => {
    const v = makeView({ onSave: vi.fn(), onQuickOpen: vi.fn() })
    const event = dispatchKey(v, { key: 'F3', code: 'F3', shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
  })

  it('an unbound key is not intercepted (falls through to normal typing)', () => {
    const v = makeView({ onSave: vi.fn(), onQuickOpen: vi.fn() }, 'hi')
    const event = dispatchKey(v, { key: 'x', code: 'KeyX' })
    expect(event.defaultPrevented).toBe(false)
  })
})

// diffKeymap (2.18): the same navigation/search bindings as sourceKeymap,
// minus Mod-s (DiffView is always read-only, so there is nothing to save).

function makeDiffView(onQuickOpen: () => void, doc = 'hello world'): EditorView {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [diffKeymap({ onQuickOpen })] }),
    parent: document.body,
  })
  return view
}

describe('diffKeymap', () => {
  it('Mod-p calls onQuickOpen', () => {
    const onQuickOpen = vi.fn()
    const v = makeDiffView(onQuickOpen)
    dispatchKey(v, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(onQuickOpen).toHaveBeenCalledTimes(1)
  })

  it('Mod-g opens the goto-line panel, overriding search default findNext', () => {
    const v = makeDiffView(vi.fn())
    const event = dispatchKey(v, { key: 'g', code: 'KeyG', ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(v.dom.querySelector('.cm-goto-line')).not.toBeNull()
    expect(v.dom.querySelector('.cm-search')).toBeNull()
  })

  it('Mod-f opens the search panel', () => {
    const v = makeDiffView(vi.fn())
    const event = dispatchKey(v, { key: 'f', code: 'KeyF', ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(v.dom.querySelector('.cm-search')).not.toBeNull()
  })

  it('F3 is handled by the keymap (bound to findNext)', () => {
    const v = makeDiffView(vi.fn())
    const event = dispatchKey(v, { key: 'F3', code: 'F3' })
    expect(event.defaultPrevented).toBe(true)
  })

  it('Shift-F3 is handled by the keymap (bound to findPrevious)', () => {
    const v = makeDiffView(vi.fn())
    const event = dispatchKey(v, { key: 'F3', code: 'F3', shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
  })

  it('Mod-s is NOT bound (no save affordance in a read-only view)', () => {
    const v = makeDiffView(vi.fn(), 'hello world')
    const event = dispatchKey(v, { key: 's', code: 'KeyS', ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
  })

  it('an unbound key is not intercepted', () => {
    const v = makeDiffView(vi.fn(), 'hi')
    const event = dispatchKey(v, { key: 'x', code: 'KeyX' })
    expect(event.defaultPrevented).toBe(false)
  })
})
