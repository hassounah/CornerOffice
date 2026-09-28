import React, { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers, drawSelection } from '@codemirror/view'
import { foldGutter, bracketMatching } from '@codemirror/language'
import { search, highlightSelectionMatches } from '@codemirror/search'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import type { CodeBaselineResponse, CodeFileResponse } from '@main/types/code'
import { officeTheme, realmTheme } from './cm/themes'
import { diffKeymap } from './cm/keymap'
import { reviewSafetyExtensions } from './cm/review-safety'
import { loadLanguageForFile } from './cm/languages'
import { eolOnlyChange } from '../../utils/text-utils'
import { useIsThemeLight } from '../../hooks/useIsThemeLight'
import { ExplorerNotice } from './ExplorerNotice'
import {
  binaryFileChangedNotice,
  tooLargeToCompareNotice,
  baseVersionUnavailableNotice,
  secretDiffNotice,
  eolOnlyChangeNotice,
} from './notice-copy'

// ---------------------------------------------------------------------------
// DiffView — the Changes view (TRD §3.6.8, FR-18, FR-19, FR-26). Pure and
// store-agnostic, like SourceView/MarkdownContent: the caller (CodePane,
// 2.17) reads the store and passes `original` (readBaseline's response,
// §3.4.2) and `current` (the open file, or the synthetic `{kind:'deleted'}`
// for a removed-on-disk change — "current is file.content, or '' when the
// file is deleted", TRD §3.6.8) straight through, with no translation layer.
// Always read-only: there is no edit affordance anywhere in this view.
//
// Card priority is chosen by ACCESS first, CONTENT second — not the literal
// bullet order TRD §3.6.8 lists them in (binary, too-large, unavailable,
// secret, EOL-only). A `secret` or `unavailable` side was never actually
// read, so its content was never classified as binary/too-large/text at
// all; checking binary/too-large first would risk a nonsensical card like
// "Binary file changed (0 bytes → ...)" for a file whose bytes we never
// saw. The real order applied here: secret → unavailable → binary →
// too-large → EOL-only → the real diff.
// ---------------------------------------------------------------------------

export interface DiffViewProps {
  /** Used only to pick a language and name the region — never rendered here. */
  relPath: string
  /** False for a file already classified `highlight: false` — skips language
   *  loading entirely, same contract as SourceView. */
  highlight: boolean
  skin: 'office' | 'realm'
  layout: 'inline' | 'split'
  /** readBaseline's response (`oldPath` already resolved by the caller). */
  original: CodeBaselineResponse
  /** The open file, or `{kind:'deleted'}` for a change whose path no longer
   *  exists on disk — the "removed content" row of TRD §3.6.4's table. */
  current: CodeFileResponse | { kind: 'deleted' }
  onQuickOpen: () => void
  /** Wired to the store's `reveal()` action when either side may be a
   *  secret — omitted (and the Reveal button hidden) when neither side can
   *  be. */
  onReveal?: () => void
}

// --- side classification -----------------------------------------------

function byteCountOf(side: CodeBaselineResponse | CodeFileResponse | { kind: 'deleted' }): number {
  switch (side.kind) {
    case 'binary':
    case 'too-large':
      return side.size
    case 'text':
      // CodeFileResponse's text kind carries `size`; CodeBaselineResponse's
      // does not (§3.4.2's baseline response has no size field for text) —
      // an accurate UTF-8 byte count is cheap enough to compute directly
      // rather than special-casing the two response shapes.
      return 'size' in side ? side.size : new TextEncoder().encode(side.content).length
    // 'absent' (no baseline — a newly added file) and the synthetic
    // 'deleted' (removed-on-disk) both mean "nothing on this side": 0 bytes.
    default:
      return 0
  }
}

/** Text content for a side once no access-level card applies — 'absent'
 *  becomes '' (an added file has no prior text) and 'deleted' becomes ''
 *  (a removed file has no current text), matching TRD §3.6.8. */
function textOf(side: CodeBaselineResponse | CodeFileResponse | { kind: 'deleted' }): string {
  return side.kind === 'text' ? side.content : ''
}

interface DiffCard {
  card: 'secret' | 'unavailable' | 'binary' | 'too-large' | 'eol-only'
  message: string
}

function selectCard(original: CodeBaselineResponse, current: CodeFileResponse | { kind: 'deleted' }): DiffCard | null {
  if (original.kind === 'secret' || current.kind === 'secret') {
    // Fix #135 item 3: name which side(s) are hidden rather than a generic
    // "this file" message that doesn't distinguish original from current.
    const which = original.kind === 'secret' && current.kind === 'secret' ? 'both' : original.kind === 'secret' ? 'original' : 'current'
    return { card: 'secret', message: secretDiffNotice(which) }
  }
  if (original.kind === 'unavailable') {
    return { card: 'unavailable', message: baseVersionUnavailableNotice() }
  }
  if (original.kind === 'binary' || current.kind === 'binary') {
    return { card: 'binary', message: binaryFileChangedNotice(byteCountOf(original), byteCountOf(current)) }
  }
  if (original.kind === 'too-large' || current.kind === 'too-large') {
    return { card: 'too-large', message: tooLargeToCompareNotice() }
  }
  const eol = eolOnlyChange(textOf(original), textOf(current))
  if (eol) {
    return { card: 'eol-only', message: eolOnlyChangeNotice(eol.from, eol.to) }
  }
  return null
}

// --- rendering -----------------------------------------------------------

// No reset-to-null on `relPath` change: the parent keys DiffView by
// `relPath:fileReq` (same contract as SourceView, §3.6.5), so a different
// file remounts this whole component and `useState(null)`'s own initializer
// already covers that case.
function usePaneLanguage(relPath: string, highlight: boolean): Extension | null {
  const [languageExt, setLanguageExt] = useState<Extension | null>(null)
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
  return languageExt
}

function InlineDiff({
  relPath,
  originalText,
  currentText,
  languageExt,
  skin,
  onQuickOpen,
}: {
  relPath: string
  originalText: string
  currentText: string
  languageExt: Extension | null
  skin: 'office' | 'realm'
  onQuickOpen: () => void
}): React.ReactElement {
  // Fix #148: see SourceView.tsx's identical comment — memoized so its
  // reference only changes when it actually needs to, reusing
  // @uiw/react-codemirror's existing reconfigure-without-remount machinery
  // for the `theme` prop.
  const isThemeLight = useIsThemeLight()
  const theme = useMemo(
    () => (skin === 'realm' ? realmTheme(!isThemeLight) : officeTheme(!isThemeLight)),
    [skin, isThemeLight],
  )

  const extensions = useMemo<Extension[]>(() => {
    const base: Extension[] = [
      lineNumbers(),
      drawSelection(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorState.tabSize.of(2),
      unifiedMergeView({
        original: originalText,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
        diffConfig: { scanLimit: 10_000, timeout: 1_000 },
      }),
      reviewSafetyExtensions,
      diffKeymap({ onQuickOpen }),
      EditorView.contentAttributes.of({ 'aria-label': `${relPath} — changes` }),
    ]
    return languageExt ? [...base, languageExt] : base
    // originalText intentionally excluded: unifiedMergeView is only ever
    // (re)configured through this memo when the identity above changes;
    // this component is remounted (new `original`/`current` requires a new
    // `key` from the caller, same "keyed by relPath:fileReq" contract as
    // SourceView) rather than reconfigured in place, so a stale captured
    // `originalText` inside an old extensions array never lingers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relPath, languageExt, onQuickOpen])

  return (
    <CodeMirror
      value={currentText}
      height="100%"
      basicSetup={false}
      theme={theme}
      readOnly={true}
      extensions={extensions}
      onCreateEditor={(view) => {
        // unifiedMergeView paints its deleted-chunk widgets into `view.dom`
        // as part of THIS SAME construction, but ViewPlugin constructors
        // (deletedChunkInvisibleMarker included, reviewSafetyExtensions,
        // §3.6.6) run before that paint — so on the very first render,
        // markDeletedChunks's `view.dom.querySelectorAll('.cm-deletedChunk')`
        // scan finds nothing yet. An empty dispatch forces one deterministic
        // extra ViewUpdate synchronously, right here, so every plugin
        // (including this one) gets a chance to scan the fully-painted DOM
        // before the view is ever shown — an interaction-independent gap in
        // a Trojan-Source defense is exactly the kind of thing M7 (joint
        // High) exists to close.
        //
        // Fix #135 item 7: deletedChunkInvisibleMarker's constructor now
        // ALSO self-heals via `view.requestMeasure` (cm/review-safety.ts),
        // so a future unifiedMergeView consumer that forgets this dispatch
        // is still covered for its OWN construction-time gap in a real
        // browser — requestMeasure's callback runs before the next paint,
        // so nothing is ever actually shown unwrapped there. It is NOT a
        // substitute for keeping this dispatch, though: requestMeasure is
        // still asynchronous relative to this synchronous call stack (it
        // waits for CM6's next measure/animation-frame cycle), so it can't
        // give the same "never shown unwrapped, full stop, no reliance on a
        // paint cycle at all" guarantee this dispatch's fully-synchronous
        // re-render does — empirically confirmed by removing this line: the
        // "REAL deleted chunk" test's synchronous assertion (right after
        // its `waitFor`) then failed, since requestMeasure's callback
        // hadn't run yet at that point. Kept as the stronger guarantee for
        // this view; requestMeasure is defense-in-depth for other
        // consumers that don't have their own equivalent.
        view.dispatch({})
      }}
    />
  )
}

function SplitDiff({
  relPath,
  originalText,
  currentText,
  languageExt,
  skin,
}: {
  relPath: string
  originalText: string
  currentText: string
  languageExt: Extension | null
  skin: 'office' | 'realm'
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<MergeView | null>(null)
  // One Compartment slot per mount, reused by BOTH panes' extension arrays
  // below — a Compartment is just a slot identity, not tied to one
  // EditorState, so the same instance can hold each pane's own theme
  // independently and still be reconfigured on both with one dispatch call
  // each (Fix #150).
  const themeCompartmentRef = useRef<Compartment>(new Compartment())
  const isThemeLight = useIsThemeLight()

  useEffect(() => {
    const parent = containerRef.current
    if (!parent) return

    const themeCompartment = themeCompartmentRef.current
    const theme = themeCompartment.of(skin === 'realm' ? realmTheme(!isThemeLight) : officeTheme(!isThemeLight))
    // Fix #135 item 1: each pane needs its OWN aria-label — the two panes
    // previously shared one `paneExtensions` array (and therefore the same
    // "<relPath> — changes" label on both), so a screen-reader user in
    // split mode couldn't tell which pane was old and which was new. The
    // shared base is everything else (search/fold/theme/review-safety),
    // never reused as one array reference across both `a`/`b` configs.
    const sharedBase: Extension[] = [
      lineNumbers(),
      drawSelection(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorState.tabSize.of(2),
      EditorState.readOnly.of(true),
      theme,
      reviewSafetyExtensions,
    ]
    const withLanguage = languageExt ? [...sharedBase, languageExt] : sharedBase
    const aExtensions = [...withLanguage, EditorView.contentAttributes.of({ 'aria-label': `${relPath} — before` })]
    const bExtensions = [...withLanguage, EditorView.contentAttributes.of({ 'aria-label': `${relPath} — after` })]

    const view = new MergeView({
      a: { doc: originalText, extensions: aExtensions },
      b: { doc: currentText, extensions: bExtensions },
      parent,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
      diffConfig: { scanLimit: 10_000, timeout: 1_000 },
    })
    viewRef.current = view

    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Fix #150: `isThemeLight` deliberately NOT a dependency here anymore —
    // see the effect below, which reconfigures the SAME view's theme
    // Compartment in place instead of tearing this one down. Everything
    // else keeps the original "remount on identity change" contract: the
    // caller keys this component by relPath:fileReq, so a full teardown/
    // rebuild on any of THESE changing is still the correct, simple
    // behavior — only a real skin/file/comparison change should reset
    // scroll to the top.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relPath, originalText, currentText, languageExt, skin])

  // Fix #150: reconfigures the theme Compartment on the EXISTING MergeView's
  // two panes (`view.a`/`view.b`, both real EditorViews) via a normal
  // dispatch — CodeMirror's own guarantee for a reconfigure transaction is
  // that scroll position, selection and undo history all survive it, unlike
  // the full destroy+rebuild the effect above does. `isThemeLight` toggling
  // is a global, app-wide setting (Settings → Appearance, or the OS
  // preference under "system") that can change at any moment while the user
  // is scrolled through this exact diff — unlike relPath/skin/etc., it was
  // never a reason to reset the view. Runs once (harmlessly) right after the
  // effect above on initial mount too, re-applying the same theme it was
  // just built with.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const theme = skin === 'realm' ? realmTheme(!isThemeLight) : officeTheme(!isThemeLight)
    const themeCompartment = themeCompartmentRef.current
    view.a.dispatch({ effects: themeCompartment.reconfigure(theme) })
    view.b.dispatch({ effects: themeCompartment.reconfigure(theme) })
  }, [isThemeLight, skin])

  return <div ref={containerRef} className="cm-co-mergeview h-full" />
}

export function DiffView({ relPath, highlight, skin, layout, original, current, onQuickOpen, onReveal }: DiffViewProps): React.ReactElement {
  const languageExt = usePaneLanguage(relPath, highlight)
  const card = selectCard(original, current)

  if (card) {
    const tone = card.card === 'secret' || card.card === 'unavailable' ? 'warning' : 'info'
    const actions = card.card === 'secret' && onReveal ? [{ label: 'Reveal', onClick: onReveal }] : undefined
    return (
      <div className="flex h-full items-start p-3">
        <ExplorerNotice tone={tone} message={card.message} role="status" actions={actions} id={`diff-card:${card.card}`} />
      </div>
    )
  }

  const originalText = textOf(original)
  const currentText = textOf(current)

  return layout === 'inline' ? (
    <InlineDiff relPath={relPath} originalText={originalText} currentText={currentText} languageExt={languageExt} skin={skin} onQuickOpen={onQuickOpen} />
  ) : (
    <SplitDiff relPath={relPath} originalText={originalText} currentText={currentText} languageExt={languageExt} skin={skin} />
  )
}
