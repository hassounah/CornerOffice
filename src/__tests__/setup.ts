import '@testing-library/jest-dom/vitest'

// jsdom has no modal <dialog> API. Minimal stand-in that toggles `open`, so a
// dialog opened via showModal() is visible to queries. Suites that need to spy
// on these still override them with vi.fn().
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false
}

// CodeMirror 6 measures its own text layout via Range.getClientRects /
// getBoundingClientRect, neither of which jsdom implements (TRD §11 R12).
// Stubbed globally, once, so every test that mounts a real EditorView
// (SourceView, 2.16; DiffView, 2.18; Quick-open, 2.19; ...) doesn't need its
// own copy of this workaround. Zero-size rects are enough — these tests
// query rendered DOM text/attributes, never layout.
const zeroRect: DOMRect = {
  x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
  toJSON: () => ({}),
}
Range.prototype.getBoundingClientRect = () => zeroRect
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
