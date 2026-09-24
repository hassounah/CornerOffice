import '@testing-library/jest-dom'

// jsdom has no modal <dialog> API. Minimal stand-in that toggles `open`, so a
// dialog opened via showModal() is visible to queries. Suites that need to spy
// on these still override them with vi.fn().
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false
}
