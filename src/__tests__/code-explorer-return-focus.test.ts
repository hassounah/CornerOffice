import { describe, it, expect, beforeEach } from 'vitest'
import { setPendingReturnFocus, consumeReturnFocus } from '../renderer/utils/code-explorer-return-focus'

// ---------------------------------------------------------------------------
// code-explorer-return-focus.ts — Office's focus-return mechanism (TRD
// §3.8.1 NFR-5, step 2.21). Pure module-level state + a DOM query — no store,
// so no CodeMirror import risk to verify here beyond "this file imports
// nothing from stores/code-explorer-store" (checked by inspection, not a
// runtime assertion this test can make).
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.body.innerHTML = ''
  setPendingReturnFocus(null) // clear any pending id left over from a prior test
})

function makeTrigger(id: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.setAttribute('data-return-focus', id)
  document.body.appendChild(btn)
  return btn
}

describe('setPendingReturnFocus / consumeReturnFocus', () => {
  it('focuses the element with the matching data-return-focus id', () => {
    const trigger = makeTrigger('browse-code')
    setPendingReturnFocus('browse-code')
    consumeReturnFocus()
    expect(trigger).toHaveFocus()
  })

  it('is a no-op when nothing is pending', () => {
    const trigger = makeTrigger('browse-code')
    consumeReturnFocus()
    expect(trigger).not.toHaveFocus()
  })

  it('is a no-op when the pending id matches no element', () => {
    setPendingReturnFocus('review:some-pipeline')
    expect(() => consumeReturnFocus()).not.toThrow()
  })

  it('only consumes once — a second call is a no-op even if the id would still match', () => {
    const trigger = makeTrigger('browse-code')
    setPendingReturnFocus('browse-code')
    consumeReturnFocus()
    trigger.blur()
    consumeReturnFocus()
    expect(trigger).not.toHaveFocus()
  })

  it('escapes special characters in the id for the CSS selector', () => {
    const trigger = makeTrigger('review:feat/0028"quoted"')
    setPendingReturnFocus('review:feat/0028"quoted"')
    expect(() => consumeReturnFocus()).not.toThrow()
    expect(trigger).toHaveFocus()
  })
})
