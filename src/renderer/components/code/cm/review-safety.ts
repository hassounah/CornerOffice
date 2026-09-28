import type { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, highlightSpecialChars } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { INVISIBLE_CHAR_NAMES, describeInvisibleChar } from '../../../utils/name-safety'

// ---------------------------------------------------------------------------
// cm/review-safety.ts — invisible and bidi character safety for every
// CodeMirror view (TRD §3.6.6, joint High, M7): SourceView, the inline
// Changes view, and both MergeView panes all install reviewSafetyExtensions.
//
// The flagged set is the SAME one name-safety.ts uses for names — built from
// numeric code points here too, never a source-literal character or \u
// escape, so this file can't itself smuggle one of the characters it exists
// to flag.
// ---------------------------------------------------------------------------

// `\u{XXXX}` code-point escapes inside the regex SOURCE STRING (ASCII text
// like the six characters "\", "u", "{", ...), never the actual character.
function invisibleCharClassSource(): string {
  const escapes = INVISIBLE_CHAR_NAMES.map(([codePoint]) => `\\u{${codePoint.toString(16)}}`).join('')
  return `[${escapes}]`
}

/** Matches any of the flagged code points. The 'u' flag is required for the
 *  `\u{...}` escapes above; 'g' so a single instance can be reused for
 *  repeated `exec` calls when scanning a whole document. */
export const invisibleCharsRegExp = new RegExp(invisibleCharClassSource(), 'gu')

export interface InvisibleCharMatch {
  codePoint: number
  index: number
}

/** Scan `text` for every flagged character, in order. */
export function findInvisibleChars(text: string): InvisibleCharMatch[] {
  const re = new RegExp(invisibleCharsRegExp.source, 'gu')
  const matches: InvisibleCharMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    matches.push({ codePoint: m[0].codePointAt(0) ?? 0, index: m.index })
  }
  return matches
}

// ---------------------------------------------------------------------------
// Decoration pipeline: covers everything highlightSpecialChars normally
// reaches (the document itself, in every view).
// ---------------------------------------------------------------------------

const highlightInvisible = highlightSpecialChars({
  addSpecialChars: invisibleCharsRegExp,
  render(code) {
    const described = describeInvisibleChar(code)
    const span = document.createElement('span')
    span.className = 'cm-co-invisible'
    if (described) {
      span.textContent = described.placeholder
      span.title = described.title
      span.setAttribute('aria-label', described.title)
    } else {
      // Defensive: highlightSpecialChars only ever calls render() for chars
      // matched by our own regex, so this never actually happens.
      span.textContent = `\\u{${code.toString(16)}}`
    }
    return span
  },
})

// ---------------------------------------------------------------------------
// deletedChunkInvisibleMarker: unifiedMergeView renders deleted chunks as
// widgets outside the normal decoration pipeline, so highlightSpecialChars
// never reaches them. This ViewPlugin walks their text nodes after every
// update and wraps matches in the same `.cm-co-invisible` placeholder,
// skipping nodes it has already wrapped (idempotent).
// ---------------------------------------------------------------------------

function isAlreadyWrapped(node: Text): boolean {
  return node.parentElement?.classList.contains('cm-co-invisible') === true
}

function wrapInvisibleCharsInTextNode(textNode: Text): void {
  const text = textNode.data
  const re = new RegExp(invisibleCharsRegExp.source, 'gu')
  if (!re.test(text)) return
  re.lastIndex = 0

  const parent = textNode.parentNode
  if (!parent) return

  const frag = document.createDocumentFragment()
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
    }
    const codePoint = match[0].codePointAt(0) ?? 0
    const described = describeInvisibleChar(codePoint)
    const span = document.createElement('span')
    span.className = 'cm-co-invisible'
    if (described) {
      span.textContent = described.placeholder
      span.title = described.title
      span.setAttribute('aria-label', described.title)
    } else {
      // Defensive: the regex only ever matches code points from the same
      // table describeInvisibleChar reads, so this never actually happens.
      // Same ASCII-only fallback as render() above — never the raw
      // character, even if the regex and the name table ever drift apart.
      span.textContent = `\\u{${codePoint.toString(16)}}`
    }
    frag.appendChild(span)
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIndex)))
  }
  parent.replaceChild(frag, textNode)
}

function markDeletedChunks(view: EditorView): void {
  const chunks = view.dom.querySelectorAll('.cm-deletedChunk')
  for (const chunk of Array.from(chunks)) {
    const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let node = walker.nextNode()
    while (node) {
      const textNode = node as Text
      if (!isAlreadyWrapped(textNode)) textNodes.push(textNode)
      node = walker.nextNode()
    }
    for (const textNode of textNodes) wrapInvisibleCharsInTextNode(textNode)
  }
}

export const deletedChunkInvisibleMarker = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      markDeletedChunks(view)
      // Fix #135 item 7: unifiedMergeView paints its `.cm-deletedChunk`
      // widgets as part of the SAME `new EditorView(...)` construction this
      // plugin's own constructor runs inside of, but that paint can land
      // AFTER this constructor already ran its scan above — so the first
      // pass can see nothing yet, an interaction-independent gap in a
      // Trojan-Source defense (M7, joint High). Self-heal here via
      // `requestMeasure`, CM6's idiomatic "run after the next DOM
      // layout/paint" hook, instead of requiring every caller to know about
      // and add its own forced re-dispatch (DiffView.tsx/2.18 used to do
      // this locally; now any future unifiedMergeView consumer is covered
      // automatically). The scan itself both reads (querySelectorAll/
      // TreeWalker) and writes (replaceChild) in one interleaved pass, so it
      // runs from `write` rather than `read` (which must not mutate).
      view.requestMeasure({ read: () => {}, write: () => markDeletedChunks(view) })
    }
    update(update: ViewUpdate): void {
      markDeletedChunks(update.view)
    }
  },
)

export const reviewSafetyExtensions: Extension = [highlightInvisible, deletedChunkInvisibleMarker]
