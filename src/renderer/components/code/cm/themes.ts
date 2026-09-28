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
// from the deployed theme. Both officeTheme and realmTheme resolve almost
// entirely through CSS custom properties (dark values in `:root`, light
// overrides in `.theme-light` — see globals.css), which need no JS at all:
// the browser's own cascade re-themes an already-mounted editor the instant
// `.theme-light` toggles.
//
// ONE thing isn't CSS, though (Fix #148): `EditorView.theme(spec, { dark })`
// — CodeMirror's OWN internal light/dark classification — is a structural
// Extension option, not a CSS value, and several built-in/third-party
// extensions (notably @codemirror/merge's diff/merge decoration colors) key
// off it via `&light`/`&dark` selectors. `officeTheme`/`realmTheme` are
// therefore FUNCTIONS of a `dark` boolean, not static Extensions — callers
// pass `!useIsThemeLight()` (hooks/useIsThemeLight.ts) and re-derive the
// Extension (memoized) whenever it changes; @uiw/react-codemirror's own
// `theme` prop already reconfigures the live view on a changed reference,
// with no remount, exactly like its `readOnly`/`indentWithTab` props
// (SourceView.tsx's header comment) — so this still needs no manual
// Compartment of its own. SplitDiff (DiffView.tsx), which builds a raw
// `@codemirror/merge` `MergeView` outside that wrapper, already tears down
// and rebuilds on any relevant prop change, so this is just one more
// dependency in its existing effect.
//
// #0028 user decision (2026-09-28): Realm's code explorer used to be a fixed
// warm-dark palette regardless of the app's appearance setting ("Realm has
// no light mode"). It now has its own light "parchment" palette
// (`--co-realm-*`), toggling exactly like officeTheme's `--co-code-*` does —
// scoped to the code explorer only; the rest of the Realm skin (map, Study,
// etc.) is unaffected and stays fixed-dark.
// ---------------------------------------------------------------------------

function editorTheme(
  vars: {
    bg: string
    fg: string
    caret: string
    selection: string
    gutterBg: string
    gutterFg: string
    activeLine: string
  },
  dark: boolean,
): Extension {
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
    { dark },
  )
}

// --- officeTheme -------------------------------------------------------------
// Colors are CSS custom properties defined in globals.css: dark values in
// :root, light overrides in .theme-light (TRD: "uses CSS variables --co-code-*
// for dark and .theme-light").

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

/** `dark` — CodeMirror's own internal light/dark classification (Fix #148),
 *  NOT the CSS palette (that always resolves through `--co-code-*` either
 *  way). Callers pass `!useIsThemeLight()`. */
export function officeTheme(dark: boolean): Extension {
  const officeEditorTheme = editorTheme(
    {
      bg: 'var(--co-code-bg)',
      fg: 'var(--co-code-fg)',
      caret: 'var(--co-code-caret)',
      selection: 'var(--co-code-selection)',
      gutterBg: 'var(--co-code-gutter-bg)',
      gutterFg: 'var(--co-code-gutter-fg)',
      activeLine: 'var(--co-code-active-line)',
    },
    dark,
  )
  return [officeEditorTheme, syntaxHighlighting(officeHighlightStyle)]
}

// --- realmTheme --------------------------------------------------------------
// Colors are CSS custom properties defined in globals.css: dark values in
// :root (the original fixed warm-dark palette, TRD §3.6.5 — its `comment`
// value is #96835f, not the #8a7757 the TRD names literally, which is only
// 4.33:1 on #17110a, below the TRD's own 4.5:1 requirement; #96835f keeps
// the same muted warm-brown hue at 5.09:1 — flagged to the team lead for the
// TRD to be corrected), light overrides in .theme-light (the parchment
// palette, #0028 user decision 2026-09-28).

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

/** `dark` — CodeMirror's own internal light/dark classification (Fix #148),
 *  NOT the CSS palette (that always resolves through `--co-realm-*` either
 *  way). Callers pass `!useIsThemeLight()`. */
export function realmTheme(dark: boolean): Extension {
  const realmEditorTheme = editorTheme(
    {
      bg: 'var(--co-realm-bg)',
      fg: 'var(--co-realm-fg)',
      caret: 'var(--co-realm-caret)',
      selection: 'var(--co-realm-selection)',
      gutterBg: 'var(--co-realm-gutter-bg)',
      gutterFg: 'var(--co-realm-gutter-fg)',
      activeLine: 'var(--co-realm-active-line)',
    },
    dark,
  )
  return [realmEditorTheme, syntaxHighlighting(realmHighlightStyle)]
}
