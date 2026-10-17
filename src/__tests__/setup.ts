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

// #0038: unit tests are hermetic with respect to the dev-profile env knobs. The suite also runs
// inside a Corner Office sandbox, where CORNER_OFFICE_SANDBOX=1 would flip app-home into sandbox mode.
delete process.env.CORNER_OFFICE_SANDBOX
delete process.env.CORNER_OFFICE_PROFILE
delete process.env.CORNER_OFFICE_DEBUG_PORT
// ...and to electron-vite's dev env, inherited when the suite runs from a terminal inside `make dev`;
// it would switch main/index.ts to the dev CSP and renderer URL.
delete process.env.ELECTRON_RENDERER_URL
delete process.env.NODE_ENV_ELECTRON_VITE
process.env.NODE_ENV = 'test'
