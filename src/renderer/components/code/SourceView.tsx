import React, { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { Extension, Text } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import type { ViewUpdate } from '@codemirror/view'
import { EditorView, lineNumbers, drawSelection } from '@codemirror/view'
import { foldGutter, bracketMatching } from '@codemirror/language'
import { search, highlightSelectionMatches } from '@codemirror/search'
import { history } from '@codemirror/commands'
import { officeTheme, realmTheme } from './cm/themes'
import { sourceKeymap } from './cm/keymap'
import { reviewSafetyExtensions } from './cm/review-safety'
import { loadLanguageForFile } from './cm/languages'
import { minimalChange } from '../../utils/text-utils'
import { useIsThemeLight } from '../../hooks/useIsThemeLight'

// ---------------------------------------------------------------------------
// SourceView — the CodeMirror integration (TRD §3.6.5, §3.6.6). Uncontrolled:
// `content` is captured once per mount (the parent keys this element by
// `relPath:fileReq` so a different file — or a reload — remounts it, per
// §3.6.5's "keyed by relPath:fileReq" contract) and there is no `onChange`;
// `onUpdate` feeds `onDocChange` instead, and later imperative updates (a
// disk-change reload, 2.20) go through `onReady`'s exposed `controls`
// (Fix #129), never through this component's `content` prop: `controls.
// applyExternalContent(newContent)` dispatches a targeted minimalChange
// transaction instead of a blunt full-document replace, for both the
// view-mode silent-reload and editing-clean reload-in-place rows of §3.9.2.
// The editing-clean row must also call `controls.rebaseline()` in the same
// tick: `onDocChange`'s dirty check compares against a baseline captured
// once at mount, so an external dispatch with no rebaseline would
// self-report dirty:true for a reload nobody typed.
//
// Pure, store-agnostic (like MarkdownContent/YamlContent, §3.6.7): CodePane
// (2.17) owns reading the store and threads plain props down, so this file
// stays independently testable and reusable for both skins.
//
// `readOnly`, `theme` and `indentWithTab` are the wrapper's OWN first-class
// props — @uiw/react-codemirror already reconfigures the live EditorView via
// a full `StateEffect.reconfigure` whenever any of them changes reference,
// without remounting (see its useCodeMirror.ts). That's the same outcome
// TRD's own "compartments for readOnly, theme and indentWithTab" calls for,
// so this file doesn't build redundant Compartments for those three — only
// the async-loaded language extension needs this component's own state,
// since it lives inside the `extensions` array rather than a top-level prop.
// Fix #148 reuses this SAME mechanism for CodeMirror's internal dark/light
// flag (`theme`'s memo below re-derives officeTheme/realmTheme whenever
// `useIsThemeLight()` changes), rather than adding a second Compartment.
// ---------------------------------------------------------------------------

export interface SourceViewControls {
  /** Sets the dirty-comparison baseline to the view's CURRENT document,
   *  synchronously (Fix #129). The caller dispatches a new document into the
   *  live view (a disk-reload-in-place patch, 2.20) and calls this in the
   *  SAME tick, so that dispatch's own `onUpdate` never sees the stale,
   *  pre-reload baseline and misreports `dirty: true` for a reload nobody
   *  typed. */
  rebaseline: () => void
  /** Applies `newContent` as a targeted transaction — the common-prefix/
   *  common-suffix `minimalChange` diff (text-utils.ts, already used for the
   *  same reason by the store's own editing-clean reload) between the
   *  view's CURRENT document and `newContent`, dispatched via
   *  `view.dispatch`. Never assign through this component's `content` prop
   *  instead: `@uiw/react-codemirror` reacts to a changed `value` by
   *  dispatching a blunt full-document replace, which would blow scroll and
   *  selection and add an oversized entry to `history()` — exactly what
   *  TRD §3.9.2's silent-reload rows (view-mode AND editing-clean) exist to
   *  avoid. A no-op when `newContent` already matches the live document. */
  applyExternalContent: (newContent: string) => void
}

export interface SourceViewProps {
  /** Repo-relative path — used only to pick a language (loadLanguageForFile),
   *  never rendered here (the breadcrumb, 2.13, owns that). */
  relPath: string
  /** Captured once per mount — this component is uncontrolled. */
  content: string
  /** False for a file already classified `highlight: false` (too-large,
   *  lossy encoding, mixed EOL, symlink, §3.3.3) — skips language loading
   *  entirely rather than loading it and never using it. */
  highlight: boolean
  /** Drives the `readOnly` prop; never decided by this component — the store
   *  already gates `enterEdit()` on `file.editable` (2.7), so `editing` is
   *  only ever true for a file this view is allowed to edit. */
  editing: boolean
  skin: 'office' | 'realm'
  onDocChange: (doc: Text, dirty: boolean) => void
  onSave: () => void
  onQuickOpen: () => void
  onCursorChange?: (pos: { line: number; col: number }) => void
  /** Fired once, when the underlying EditorView is created — the only way a
   *  caller gets imperative access (goto-line, a future disk-change dispatch,
   *  focus) without this component exposing its own ref API. `controls`
   *  carries `rebaseline()` (Fix #129) for the disk-reload-in-place path. */
  onReady?: (view: EditorView, controls: SourceViewControls) => void
}

export function SourceView({
  relPath,
  content,
  highlight,
  editing,
  skin,
  onDocChange,
  onSave,
  onQuickOpen,
  onCursorChange,
  onReady,
}: SourceViewProps): React.ReactElement {
  const baselineRef = useRef<Text | null>(null)
  const [languageExt, setLanguageExt] = useState<Extension | null>(null)
  // Fix #148: officeTheme/realmTheme are now functions of CodeMirror's OWN
  // internal dark/light flag (distinct from the `--co-*` CSS variables they
  // also use, which need no JS at all) — memoized so its reference only
  // changes when it actually needs to, letting the `theme` prop below reuse
  // @uiw/react-codemirror's existing reconfigure-without-remount machinery.
  const isThemeLight = useIsThemeLight()
  const theme = useMemo(
    () => (skin === 'realm' ? realmTheme(!isThemeLight) : officeTheme(!isThemeLight)),
    [skin, isThemeLight],
  )
  // Fix #140: `content` must be captured ONCE per mount, exactly as this
  // file's own header comment already claimed — `useState(content)`'s
  // initial-value argument is only ever used on the first render, so this
  // stays the MOUNT-TIME value no matter how many times the `content` prop
  // itself changes later (a silent disk-reload, §3.9.2, re-renders CodePane
  // with a new `file.content` for the SAME key/no remount). A `useRef`
  // holding the same value would do the same job, but reading `.current`
  // during render is a lint error (react-hooks/refs — refs are for effects/
  // handlers, not render), so this uses state instead, never `setState`.
  // Passing the live `content` prop straight to `<CodeMirror value={...}>`
  // instead — the previous code — let @uiw/react-codemirror's OWN internal
  // value-diffing see that "changed" value on every such re-render and
  // dispatch its own blunt full-document replace, undoing the whole point of
  // `controls.applyExternalContent`'s targeted diff (and racing it, since
  // the wrapper's internal effect and this component's callers both react to
  // the same render). Confirmed empirically: a test that re-renders with a
  // new `content` prop and checks the live doc/selection failed before this
  // change and passes after it.
  const [initialContent] = useState(content)

  // No reset-to-null on `relPath` change here: the parent keys this element
  // by `relPath:fileReq` (see the file header comment), so a different file
  // already remounts this component — languageExt's own useState(null)
  // initializer handles that case, and setting it again synchronously in
  // this effect would just be a redundant, cascading render.
  useEffect(() => {
    if (!highlight) return
    let cancelled = false
    void loadLanguageForFile(relPath).then((support) => {
      if (!cancelled && support) setLanguageExt(support)
    })
    return () => {
      cancelled = true
    }
  }, [relPath, highlight])

  const staticExtensions = useMemo<Extension[]>(
    () => [
      lineNumbers(),
      drawSelection(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      history(),
      EditorState.tabSize.of(2),
      reviewSafetyExtensions,
      sourceKeymap({ onSave, onQuickOpen }),
      // Fix #129: names the editor region for assistive tech — otherwise a
      // screen reader announces ".cm-content" with no indication of which
      // open file it's editing.
      EditorView.contentAttributes.of({ 'aria-label': relPath }),
    ],
    [onSave, onQuickOpen, relPath],
  )

  const extensions = useMemo<Extension[]>(
    () => (languageExt ? [...staticExtensions, languageExt] : staticExtensions),
    [staticExtensions, languageExt],
  )

  function handleUpdate(vu: ViewUpdate): void {
    if (vu.docChanged) {
      const dirty = baselineRef.current ? !vu.state.doc.eq(baselineRef.current) : false
      onDocChange(vu.state.doc, dirty)
    }
    if (onCursorChange && (vu.docChanged || vu.selectionSet)) {
      const head = vu.state.selection.main.head
      const line = vu.state.doc.lineAt(head)
      onCursorChange({ line: line.number, col: head - line.from + 1 })
    }
  }

  return (
    <CodeMirror
      value={initialContent}
      height="100%"
      basicSetup={false}
      theme={theme}
      readOnly={!editing}
      indentWithTab={editing}
      extensions={extensions}
      onCreateEditor={(view, state) => {
        baselineRef.current = state.doc
        onReady?.(view, {
          rebaseline: () => {
            baselineRef.current = view.state.doc
          },
          applyExternalContent: (newContent) => {
            const change = minimalChange(view.state.doc.toString(), newContent)
            if (change) view.dispatch({ changes: change })
          },
        })
      }}
      onUpdate={handleUpdate}
    />
  )
}
