import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// ---------------------------------------------------------------------------
// cm/themes.ts — officeTheme and realmTheme (TRD §3.6.5)
//
// Every token color has been checked to reach WCAG AA (4.5:1) against its
// editor background — see themes.test.ts, which reads the actual `--co-*`
// values straight out of globals.css so the check can never silently drift
// from the deployed theme. Both themes resolve through CSS custom properties
// (`--co-code-*` follows the selected office palette; `--co-realm-*` is the
// fixed warm-dark Realm palette), so a palette switch re-themes an
// already-mounted editor through the cascade with no JS.
//
// The app is dark-only, so both themes pass `{ dark: true }` to
// `EditorView.theme`: CodeMirror's own light/dark classification, which
// extensions like @codemirror/merge key their diff decoration colors off.
// ---------------------------------------------------------------------------

function editorTheme(vars: {
  bg: string
  fg: string
  caret: string
  selection: string
  gutterBg: string
  gutterFg: string
  activeLine: string
}): Extension {
  return EditorView.theme(
    {
      '&': { backgroundColor: vars.bg, color: vars.fg, height: '100%' },
      '.cm-content': { caretColor: vars.caret },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: vars.caret },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: vars.selection,
      },
      '.cm-activeLine': { backgroundColor: vars.activeLine },
      '.cm-gutters': { backgroundColor: vars.gutterBg, color: vars.gutterFg, border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: vars.activeLine },
    },
    { dark: true },
  )
}

// --- officeTheme -------------------------------------------------------------

const officeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--co-code-comment)' },
  { tag: tags.keyword, color: 'var(--co-code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--co-code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--co-code-number)' },
  { tag: [tags.typeName, tags.className], color: 'var(--co-code-type)' },
  { tag: tags.function(tags.variableName), color: 'var(--co-code-function)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--co-code-variable)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--co-code-fg)' },
])

export const officeTheme: Extension = [
  editorTheme({
    bg: 'var(--co-code-bg)',
    fg: 'var(--co-code-fg)',
    caret: 'var(--co-code-caret)',
    selection: 'var(--co-code-selection)',
    gutterBg: 'var(--co-code-gutter-bg)',
    gutterFg: 'var(--co-code-gutter-fg)',
    activeLine: 'var(--co-code-active-line)',
  }),
  syntaxHighlighting(officeHighlightStyle),
]

// --- realmTheme --------------------------------------------------------------
// The fixed warm-dark palette (TRD §3.6.5). Its `comment` value is #96835f,
// not the #8a7757 the TRD names literally: that is only 4.33:1 on #17110a,
// below the TRD's own 4.5:1 requirement; #96835f keeps the same muted
// warm-brown hue at 5.09:1.

const realmHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--co-realm-comment)' },
  { tag: tags.keyword, color: 'var(--co-realm-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--co-realm-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--co-realm-number)' },
  { tag: [tags.typeName, tags.className], color: 'var(--co-realm-type)' },
  { tag: tags.function(tags.variableName), color: 'var(--co-realm-function)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--co-realm-fg)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--co-realm-fg)' },
])

export const realmTheme: Extension = [
  editorTheme({
    bg: 'var(--co-realm-bg)',
    fg: 'var(--co-realm-fg)',
    caret: 'var(--co-realm-caret)',
    selection: 'var(--co-realm-selection)',
    gutterBg: 'var(--co-realm-gutter-bg)',
    gutterFg: 'var(--co-realm-gutter-fg)',
    activeLine: 'var(--co-realm-active-line)',
  }),
  syntaxHighlighting(realmHighlightStyle),
]
