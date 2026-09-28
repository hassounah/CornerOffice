import React, { useRef, useState, useEffect } from 'react'
import type { CodeBaselineResponse } from '@main/types/code'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { guardAction } from '../../stores/dirty-registry'
import { SourceView, type SourceViewControls } from './SourceView'
import { StatusBar } from './StatusBar'
import { ExplorerNotice } from './ExplorerNotice'
import { MarkdownContent } from '../docviewer/MarkdownContent'
import { YamlContent } from '../docviewer/YamlContent'
import { DiffView } from './DiffView'
import {
  readOnlyReasonNotice,
  secretFileNotice,
  tooLargeToDisplayNotice,
  imagePreviewAnnouncement,
  imageLoadFailedNotice,
  formatByteCount,
} from './notice-copy'
import { isSafeRel, posixDirname, posixJoin, posixNormalize } from '../../utils/code-paths'
import { tokenizeNameToText } from '../../utils/name-safety'

// ---------------------------------------------------------------------------
// CodePane — the content pane (TRD §3.6.4, FR-14–FR-17; Sec H-3). One branch
// per file.kind/state row. Reads file/view state straight from the
// code-explorer-store, its own natural owner (2.6/2.7) — same convention as
// FileTree/ExplorerToolbar/FileHeader — and threads plain props down into
// the pure leaves it composes (SourceView, StatusBar, MarkdownContent,
// YamlContent).
//
// The View switch (Source | Preview | Changes) itself is FileHeader's job
// (2.13): CodePane only renders whichever one is currently selected. For
// `view === 'changes'`, that's DiffView (2.18, not yet built) — this file
// leaves that branch as an explicit placeholder, the same staged-build
// pattern CodeExplorer.tsx (2.13) used for CodePane itself.
// ---------------------------------------------------------------------------

export interface CodePaneProps {
  skin: 'office' | 'realm'
  /** Quick-open lives outside this component's tree (its open/close state is
   *  CodeExplorer's, 2.13/2.19) — threaded through so SourceView's Mod-P
   *  keybinding has somewhere to go, same convention as ExplorerToolbar's
   *  own `onGoToFile` prop. */
  onQuickOpen: () => void
}

/** True when a `CodeBaselineResponse` kind renders as a real, language-aware
 *  diff — false for the four kinds that short-circuit into a plain
 *  ExplorerNotice card instead (secret/unavailable/binary/too-large,
 *  DiffView's own selectCard). Loading a language extension for those would
 *  be pure waste: the card branch never uses it. `current` never needs the
 *  same check here — CodePane's own earlier branches (secret/binary/
 *  too-large above) already intercept every file.kind but 'text' before
 *  view === 'changes' is ever reached, so current is always 'text' (or the
 *  synthetic 'deleted' for the removed-change case, also never a card by
 *  itself). */
function baselineWantsHighlight(baselineKind: CodeBaselineResponse['kind']): boolean {
  return baselineKind === 'text' || baselineKind === 'absent'
}

export function CodePane({ skin, onQuickOpen }: CodePaneProps): React.ReactElement | null {
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  // Imperative bridge into the live, uncontrolled CodeMirror view (Fix #129's
  // SourceViewControls) — the only way to push a disk-driven content change
  // into an already-mounted editor without a blunt full-document replace.
  // See the effect below for when this fires.
  const sourceControlsRef = useRef<SourceViewControls | null>(null)
  const lastPushedRef = useRef<{ key: string; content: string } | null>(null)
  // `view.dispatch` (inside applyExternalContent) fires SourceView's
  // `onUpdate` SYNCHRONOUSLY, before this effect's own next line runs — so
  // by the time `rebaseline()` executes, `onDocChange` has ALREADY reported
  // this external push to the store as dirty:true (computed against the
  // stale pre-push baseline, since rebaseline can't retroactively un-fire an
  // update that already happened). `rebaseline()` alone only fixes FUTURE
  // comparisons. This flag suppresses forwarding that one synchronous,
  // store-owned-content-already-reflects-it callback — the store's own
  // `file`/`draftDoc` are already correct (handleDiskChangeDetected set them
  // itself before this effect ever ran), so the only remaining job is
  // keeping the LIVE view in sync, not re-reporting a change the store
  // already knows about as if the user had typed it.
  const suppressNextDocChangeRef = useRef(false)

  const selected = useCodeExplorerStore((s) => s.selected)
  const file = useCodeExplorerStore((s) => s.file)
  const fileLoading = useCodeExplorerStore((s) => s.fileLoading)
  const fileError = useCodeExplorerStore((s) => s.fileError)
  const view = useCodeExplorerStore((s) => s.view)
  const diffLayout = useCodeExplorerStore((s) => s.diffLayout)
  const editing = useCodeExplorerStore((s) => s.editing)
  const revealed = useCodeExplorerStore((s) => s.revealed)
  const reveal = useCodeExplorerStore((s) => s.reveal)
  const openFile = useCodeExplorerStore((s) => s.openFile)
  const onDocChange = useCodeExplorerStore((s) => s.onDocChange)
  const save = useCodeExplorerStore((s) => s.save)
  const fileReq = useCodeExplorerStore((s) => s.fileReq)
  const deletedPath = useCodeExplorerStore((s) => s.deletedPath)
  const baselineDoc = useCodeExplorerStore((s) => s.baselineDoc)

  // §3.9.2's two SILENT rows — "View mode | modified" and "Editing ∧ clean |
  // modified" — land here. handleDiskChangeDetected (the store) already
  // updates `file` (and, for the editing-clean row, `draftDoc`/
  // `baselineText`) WITHOUT bumping `fileReq`, since SourceView is
  // deliberately uncontrolled and keyed by `relPath:fileReq` (remounting on
  // every keystroke would be absurd) — so a plain prop change here is a
  // no-op for the already-mounted editor. This effect is what actually
  // notices "same file, same fileReq, content changed under us" and bridges
  // it into the live view via SourceViewControls, exactly as SourceView's
  // own doc comment prescribes (Fix #129), instead of dispatching a blunt
  // full-document replace some other way.
  //
  // A key CHANGE (a new file, or reloadFromDisk's explicit fileReq bump) is
  // a genuine remount — SourceView already mounts with the right content, so
  // this effect only records the new baseline and does nothing further.
  useEffect(() => {
    if (!file || file.kind !== 'text') {
      lastPushedRef.current = null
      return
    }
    const key = `${file.relPath}:${fileReq}`
    const prev = lastPushedRef.current
    if (!prev || prev.key !== key) {
      lastPushedRef.current = { key, content: file.content }
      return
    }
    if (prev.content === file.content) return
    const controls = sourceControlsRef.current
    if (controls) {
      suppressNextDocChangeRef.current = true
      controls.applyExternalContent(file.content)
      suppressNextDocChangeRef.current = false
      // Resets the baseline SourceView compares the NEXT real keystroke
      // against — without this, a reload nobody typed would otherwise
      // permanently poison every future dirty comparison against the stale
      // pre-reload doc (SourceView's own contract, Fix #129). Harmless in
      // view mode too, where it's simply a no-op precaution.
      controls.rebaseline()
    }
    lastPushedRef.current = { key, content: file.content }
  }, [file, fileReq])

  if (!selected) return null

  if (fileLoading) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center text-xs text-co-text-muted">Loading…</div>
    )
  }

  if (fileError) {
    return (
      <div className="flex flex-1 min-h-0 items-start p-3">
        <ExplorerNotice tone="danger" role="alert" id="code-pane:file-error" message={fileError.message} />
      </div>
    )
  }

  // A changed file whose git status is 'deleted' has no content to load —
  // `file` stays null forever for it (openFile's NOT_FOUND short-circuit).
  // §3.9.1's "Deleted change" row: View = Changes (removed content), no
  // Source, no Edit — FileHeader already hides those affordances; this is
  // the pane half of that contract. `baselineDoc` still has to arrive
  // asynchronously (fetchBaseline), so show the same Loading… placeholder
  // used everywhere else in the interim.
  //
  // Fix #141 item 4: `deletedPath` is a single store field overloaded with
  // TWO different meanings, distinguished only by whether `file` is null —
  // FileHeader.tsx documents the same split under `isDeletedChange` vs.
  // `deletedOnDisk`. THIS branch is the first meaning only: a changed file
  // already known (from git status) to be deleted, never loaded at all. The
  // other meaning — a file that WAS open and got deleted from disk while
  // being viewed (handleDiskChangeDetected's NOT_FOUND handling) — instead
  // leaves `file` holding the last-known content and never reaches this
  // branch (the `!file` guard excludes it); that case renders as an
  // ordinary view with a "Deleted on disk" notice layered on top by
  // FileHeader, not this Changes-only routing.
  if (!file && deletedPath === selected) {
    if (!baselineDoc) {
      return <div className="flex flex-1 min-h-0 items-center justify-center text-xs text-co-text-muted">Loading…</div>
    }
    return (
      <DiffView
        relPath={selected}
        highlight={baselineWantsHighlight(baselineDoc.kind)}
        skin={skin}
        layout={diffLayout}
        original={baselineDoc}
        current={{ kind: 'deleted' }}
        onQuickOpen={onQuickOpen}
        onReveal={revealed ? undefined : reveal}
      />
    )
  }

  if (!file) return null

  // code-explorer's Preview link policy (TRD §3.6.7, Sec H-3): a relative
  // href is resolved against the OPEN file's own directory, normalized, then
  // gated by isSafeRel. `:` and a leading `//` are rejected up front too, on
  // the RAW href, before any join/normalize — MarkdownContent's own
  // isExternalHref already catches both ahead of ever calling this, but this
  // is deliberate defense-in-depth, never trusting a single check alone.
  function resolveLink(href: string): (() => void) | null {
    if (href.includes(':') || href.startsWith('//')) return null
    if (!file || file.kind !== 'text') return null
    const rel = posixNormalize(posixJoin(posixDirname(file.relPath), href))
    if (!isSafeRel(rel)) return null
    return () => guardAction(() => openFile(rel), ['code-explorer'])
  }

  if (file.kind === 'secret') {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <ExplorerNotice
          tone="warning"
          id="code-pane:secret"
          message={secretFileNotice()}
          actions={revealed ? undefined : [{ label: 'Reveal', onClick: () => reveal() }]}
        />
      </div>
    )
  }

  if (file.kind === 'too-large') {
    return (
      <div className="flex flex-1 min-h-0 items-start p-3">
        <ExplorerNotice tone="info" role="status" id="code-pane:too-large" message={tooLargeToDisplayNotice(file.size)} />
      </div>
    )
  }

  if (file.kind === 'binary') {
    return (
      <div className="flex flex-1 min-h-0 items-start p-3">
        <ExplorerNotice
          tone="info"
          role="status"
          id="code-pane:binary"
          message={
            <div>
              <div>{file.mime ?? 'Binary file'}</div>
              <div className="text-co-text-muted">{formatByteCount(file.size)}</div>
            </div>
          }
        />
      </div>
    )
  }

  if (file.kind === 'image') {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        <ExplorerNotice
          tone="info"
          role="status"
          id="code-pane:image"
          message={imagePreviewAnnouncement(tokenizeNameToText(file.name))}
        />
        <div className="flex flex-1 min-h-0 items-center justify-center">
          <ImagePreview name={file.name} mime={file.mime} dataBase64={file.dataBase64} size={file.size} />
        </div>
      </div>
    )
  }

  // file.kind === 'text' from here on.

  if (view === 'changes') {
    if (!baselineDoc) {
      return <div className="flex flex-1 min-h-0 items-center justify-center text-xs text-co-text-muted">Loading…</div>
    }
    return (
      <DiffView
        relPath={file.relPath}
        highlight={file.highlight && baselineWantsHighlight(baselineDoc.kind)}
        skin={skin}
        layout={diffLayout}
        original={baselineDoc}
        current={file}
        onQuickOpen={onQuickOpen}
        onReveal={revealed ? undefined : reveal}
      />
    )
  }

  if (view === 'preview' && file.previewable) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {file.previewable === 'markdown' && <MarkdownContent content={file.content} resolveLink={resolveLink} />}
        {file.previewable === 'yaml' && <YamlContent content={file.content} />}
        {file.previewable === 'svg' && (
          <img
            alt={tokenizeNameToText(file.name)}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {file.readOnlyReason && <ExplorerNotice tone="info" message={readOnlyReasonNotice(file.readOnlyReason)} />}
      <div className="flex-1 min-h-0">
        <SourceView
          key={`${file.relPath}:${fileReq}`}
          relPath={file.relPath}
          content={file.content}
          highlight={file.highlight}
          editing={editing}
          skin={skin}
          onDocChange={(doc, dirty) => {
            // The one synchronous onUpdate fired BY the effect's own
            // applyExternalContent dispatch above — the store's `file`/
            // `draftDoc` already reflect this content (the store set them
            // itself before this effect ran); forwarding it here would
            // misreport a reload nobody typed as a live edit, since
            // `rebaseline()` can only fix FUTURE comparisons, not un-fire
            // this one.
            if (suppressNextDocChangeRef.current) return
            onDocChange(doc, dirty)
          }}
          onSave={() => void save()}
          onQuickOpen={onQuickOpen}
          onCursorChange={setCursor}
          onReady={(_view, controls) => {
            sourceControlsRef.current = controls
          }}
        />
      </div>
      <StatusBar line={cursor.line} col={cursor.col} encoding={file.encoding} eol={file.eol} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// ImagePreview — reads natural dimensions client-side (TRD §3.6.4: "<img>
// preview with dimensions and size") since CodeFileResponse's image variant
// doesn't carry them — the decoded bitmap's own dimensions are the only
// source of truth, and re-deriving them main-process-side would mean
// decoding the image twice for no benefit.
// ---------------------------------------------------------------------------

function ImagePreview({
  name,
  mime,
  dataBase64,
  size,
}: {
  name: string
  mime: string
  dataBase64: string
  size: number
}): React.ReactElement {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const src = `data:${mime};base64,${dataBase64}`
  const captionId = 'code-pane:image-caption'

  // Fix #133 item 3: a corrupt/undecodable image must not degrade silently
  // to a blank broken-image icon (TRD §3.1 principle 6) — show a notice.
  if (failed) {
    return <ExplorerNotice tone="warning" role="status" id="code-pane:image-error" message={imageLoadFailedNotice()} />
  }

  return (
    <figure className="flex flex-col items-center gap-2 p-4 m-0">
      <img
        src={src}
        alt={tokenizeNameToText(name)}
        aria-describedby={captionId}
        className="max-h-full max-w-full object-contain"
        onLoad={(e) => {
          const img = e.currentTarget
          setDims({ width: img.naturalWidth, height: img.naturalHeight })
        }}
        onError={() => setFailed(true)}
      />
      {/* Fix #133 item 4: associates dimensions/size with the <img> for
       *  assistive tech via a real figure/figcaption structure, not just
       *  adjacent text. */}
      <figcaption id={captionId} className="text-xs text-co-text-muted">
        {dims ? `${dims.width} × ${dims.height} · ` : ''}
        {formatByteCount(size)}
      </figcaption>
    </figure>
  )
}
