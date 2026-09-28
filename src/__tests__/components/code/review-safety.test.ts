import { describe, it, expect, afterEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import {
  reviewSafetyExtensions,
  invisibleCharsRegExp,
  findInvisibleChars,
  deletedChunkInvisibleMarker,
} from '../../../renderer/components/code/cm/review-safety'

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
})

// ---------------------------------------------------------------------------
// findInvisibleChars — pure scanning
// ---------------------------------------------------------------------------

describe('findInvisibleChars', () => {
  it('returns an empty array for plain text', () => {
    expect(findInvisibleChars('const x = 1;')).toEqual([])
  })

  it('finds a U+202E (RIGHT-TO-LEFT OVERRIDE) at its index', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    const text = `abc${rtlOverride}def`
    expect(findInvisibleChars(text)).toEqual([{ codePoint: 0x202e, index: 3 }])
  })

  it('finds a U+200B (ZERO WIDTH SPACE)', () => {
    const zwsp = String.fromCharCode(0x200b)
    expect(findInvisibleChars(`a${zwsp}b`)).toEqual([{ codePoint: 0x200b, index: 1 }])
  })

  it('finds multiple matches in order', () => {
    const zwsp = String.fromCharCode(0x200b)
    const rtlOverride = String.fromCharCode(0x202e)
    const text = `${zwsp}mid${rtlOverride}`
    expect(findInvisibleChars(text)).toEqual([
      { codePoint: 0x200b, index: 0 },
      { codePoint: 0x202e, index: 4 },
    ])
  })

  it('can be called repeatedly without stateful lastIndex leakage', () => {
    const zwsp = String.fromCharCode(0x200b)
    const withMatch = `a${zwsp}b`
    expect(findInvisibleChars(withMatch)).toHaveLength(1)
    expect(findInvisibleChars(withMatch)).toHaveLength(1) // not [] from a stale lastIndex
  })
})

describe('invisibleCharsRegExp', () => {
  it('is global and unicode-aware (required by highlightSpecialChars / \\u{...} escapes)', () => {
    expect(invisibleCharsRegExp.global).toBe(true)
    expect(invisibleCharsRegExp.unicode).toBe(true)
  })

  it('does not match ordinary ASCII', () => {
    const re = new RegExp(invisibleCharsRegExp.source, 'gu')
    expect(re.test('hello world 123')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reviewSafetyExtensions — wiring
// ---------------------------------------------------------------------------

describe('reviewSafetyExtensions', () => {
  it('is a usable CodeMirror extension (constructs an EditorState without throwing)', () => {
    expect(() => EditorState.create({ doc: 'hello', extensions: [reviewSafetyExtensions] })).not.toThrow()
  })

  it('renders a .cm-co-invisible placeholder for an invisible character in the document', () => {
    const zwsp = String.fromCharCode(0x200b)
    view = new EditorView({
      state: EditorState.create({ doc: `abc${zwsp}def`, extensions: [reviewSafetyExtensions] }),
      parent: document.body,
    })
    const marker = view.dom.querySelector('.cm-co-invisible')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('title')).toBe('U+200B ZERO WIDTH SPACE')
  })

  it('renders nothing special for a document with no flagged characters', () => {
    view = new EditorView({
      state: EditorState.create({ doc: 'plain text, nothing to see here', extensions: [reviewSafetyExtensions] }),
      parent: document.body,
    })
    expect(view.dom.querySelector('.cm-co-invisible')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// deletedChunkInvisibleMarker — deleted-chunk widgets sit outside the normal
// decoration pipeline (unifiedMergeView renders them as raw DOM), so this is
// exercised by injecting a `.cm-deletedChunk` node directly, the same shape
// unifiedMergeView produces, and triggering a view update.
// ---------------------------------------------------------------------------

describe('deletedChunkInvisibleMarker', () => {
  function makeViewWithDeletedChunk(text: string): EditorView {
    const v = new EditorView({
      state: EditorState.create({ doc: 'line one\nline two', extensions: [deletedChunkInvisibleMarker] }),
      parent: document.body,
    })
    const chunk = document.createElement('div')
    chunk.className = 'cm-deletedChunk'
    chunk.appendChild(document.createTextNode(text))
    v.dom.appendChild(chunk)
    return v
  }

  it('wraps a flagged character inside a .cm-deletedChunk on construction', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    view = makeViewWithDeletedChunk(`deleted${rtlOverride}text`)
    // The constructor already ran markDeletedChunks once, but the chunk was
    // appended after construction — force another pass via a no-op dispatch.
    view.dispatch({})
    const marker = view.dom.querySelector('.cm-deletedChunk .cm-co-invisible')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('title')).toBe('U+202E RIGHT-TO-LEFT OVERRIDE')
  })

  it('leaves an already-wrapped node alone on a second update (idempotent)', () => {
    const zwsp = String.fromCharCode(0x200b)
    view = makeViewWithDeletedChunk(`a${zwsp}b`)
    view.dispatch({})
    const firstPassCount = view.dom.querySelectorAll('.cm-deletedChunk .cm-co-invisible').length
    expect(firstPassCount).toBe(1)

    view.dispatch({}) // a second update must not re-wrap or duplicate markers
    const secondPassCount = view.dom.querySelectorAll('.cm-deletedChunk .cm-co-invisible').length
    expect(secondPassCount).toBe(1)
  })

  it('does not touch a deleted chunk with no flagged characters', () => {
    view = makeViewWithDeletedChunk('nothing unusual here')
    view.dispatch({})
    expect(view.dom.querySelector('.cm-deletedChunk .cm-co-invisible')).toBeNull()
  })

  it('wraps multiple flagged characters in the same chunk', () => {
    const zwsp = String.fromCharCode(0x200b)
    const rtlOverride = String.fromCharCode(0x202e)
    view = makeViewWithDeletedChunk(`${zwsp}mid${rtlOverride}`)
    view.dispatch({})
    const markers = view.dom.querySelectorAll('.cm-deletedChunk .cm-co-invisible')
    expect(markers).toHaveLength(2)
  })

  // Fix #135 item 7: the constructor now ALSO schedules a requestMeasure
  // self-heal, so a caller that never forces its own extra update (unlike
  // DiffView.tsx's dispatch({})) still gets the deleted chunk scanned once
  // CM6's next measure pass runs — no manual `view.dispatch({})` anywhere
  // in this test, unlike every other case in this describe block.
  it('self-heals via requestMeasure with no caller dispatch at all', async () => {
    const rtlOverride = String.fromCharCode(0x202e)
    view = new EditorView({
      state: EditorState.create({ doc: 'line one\nline two', extensions: [deletedChunkInvisibleMarker] }),
      parent: document.body,
    })
    // A chunk landing just after construction — the exact timing gap this
    // item exists to close (unifiedMergeView's own widget paint can land
    // after the plugin constructor's first scan).
    const chunk = document.createElement('div')
    chunk.className = 'cm-deletedChunk'
    chunk.appendChild(document.createTextNode(`deleted${rtlOverride}text`))
    view.dom.appendChild(chunk)

    await waitFor(() => {
      expect(view!.dom.querySelector('.cm-deletedChunk .cm-co-invisible')).not.toBeNull()
    })
    expect(view.dom.querySelector('.cm-deletedChunk .cm-co-invisible')?.getAttribute('title')).toBe(
      'U+202E RIGHT-TO-LEFT OVERRIDE',
    )
  })
})
