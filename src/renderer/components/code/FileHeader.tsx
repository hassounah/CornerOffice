import React, { useEffect, useRef } from 'react'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { guardAction } from '../../stores/dirty-registry'
import { gitStateBannerCopy, changedOnDiskBannerMessage, deletedOnDiskNotice } from './notice-copy'
import { ReviewSafeName } from './ReviewSafeName'
import { ExplorerNotice } from './ExplorerNotice'

// ---------------------------------------------------------------------------
// FileHeader — the §3.6.3 wireframe's file header (TRD §3.6.3, §3.6.4 row on
// Preview, joint note with 2.13): the breadcrumb, the View (Source | Preview
// | Changes) and Layout (Inline | Split) segmented controls, and the
// Edit/Save/Cancel slot. Reads everything from the code-explorer-store, its
// own natural owner (2.6/2.7) — same convention as FileTree (2.11) and
// ExplorerToolbar (2.12).
//
// CodePane (2.17) only consumes `view`/`diffLayout` from the store; this
// component owns writing them, never reading them back for its own layout.
// ---------------------------------------------------------------------------

const READ_ONLY_REASON_TEXT: Record<string, string> = {
  'too-large': 'Too large to edit (over 2 MB)',
  encoding: 'Not plain UTF-8 text',
  'mixed-eol': 'Mixed line endings',
  symlink: 'Edit the symlink target instead',
}

export function FileHeader(): React.ReactElement | null {
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const saveButtonRef = useRef<HTMLButtonElement>(null)

  const selected = useCodeExplorerStore((s) => s.selected)
  const file = useCodeExplorerStore((s) => s.file)
  const repo = useCodeExplorerStore((s) => s.repo)
  const status = useCodeExplorerStore((s) => s.status)
  const view = useCodeExplorerStore((s) => s.view)
  const setView = useCodeExplorerStore((s) => s.setView)
  const diffLayout = useCodeExplorerStore((s) => s.diffLayout)
  const setDiffLayout = useCodeExplorerStore((s) => s.setDiffLayout)
  const editing = useCodeExplorerStore((s) => s.editing)
  const dirty = useCodeExplorerStore((s) => s.dirty)
  const saving = useCodeExplorerStore((s) => s.saving)
  const enterEdit = useCodeExplorerStore((s) => s.enterEdit)
  const save = useCodeExplorerStore((s) => s.save)
  const cancelEdit = useCodeExplorerStore((s) => s.cancelEdit)
  const revealInTree = useCodeExplorerStore((s) => s.revealInTree)
  const deletedPath = useCodeExplorerStore((s) => s.deletedPath)
  const diskChange = useCodeExplorerStore((s) => s.diskChange)
  const transientNote = useCodeExplorerStore((s) => s.transientNote)
  const reloadFromDisk = useCodeExplorerStore((s) => s.reloadFromDisk)
  const keepMine = useCodeExplorerStore((s) => s.keepMine)

  // Focus management for the Edit <-> Save/Cancel swap (Fix #127): the old
  // button unmounts and the new one mounts, so nothing carries focus across
  // unless this does it explicitly. Only on an actual transition, never on
  // mount — prevEditingRef starts equal to the current value, so the first
  // render's comparison is always false.
  const prevEditingRef = useRef(editing)
  useEffect(() => {
    if (prevEditingRef.current !== editing) {
      if (editing) saveButtonRef.current?.focus()
      else editButtonRef.current?.focus()
    }
    prevEditingRef.current = editing
  }, [editing])

  if (!selected) return null

  const segments = selected.split('/')

  // Layer 1 (shared with ExplorerToolbar, 2.12): whole-RepoState degradation
  // disables View = Changes, with the GitStateBanner reason as the tooltip.
  const gitOffReason = repo ? gitStateBannerCopy(repo.state, repo.stateDetail)?.message ?? null : null

  const hasChange = status?.byPath[selected] !== undefined
  const isPreviewable = file?.kind === 'text' && file.previewable !== null
  // §3.9.1's "Deleted change" row (FR-9): a changed file whose git status is
  // 'deleted' never has content to load (`file` stays null for it — see
  // openFile's NOT_FOUND short-circuit) — View = Changes only, no Source, no
  // Edit. Distinct from `deletedPath` below, which instead tracks a file
  // deleted on disk WHILE it was open (§3.9.2's live disk-change matrix) —
  // that one keeps showing the last-known content.
  const isDeletedChange = status?.byPath[selected]?.status === 'deleted'
  // Live disk-change matrix (§3.9.2), view-mode row: the open file (already
  // loaded) vanished from disk while being viewed. Distinct from
  // `isDeletedChange` above — here `file` still holds the last-known content.
  const deletedOnDisk = !editing && deletedPath === selected && file !== null

  const changesDisabledReason = gitOffReason ?? (editing ? 'Save or cancel to see changes' : null)
  const changesDisabled = changesDisabledReason !== null

  const canEdit = file?.kind === 'text' && file.editable
  const editDisabledReason = !file
    ? null
    : file.kind !== 'text'
      ? "This file type can't be edited"
      : !file.editable
        ? (READ_ONLY_REASON_TEXT[file.readOnlyReason ?? ''] ?? 'Read-only')
        : null

  return (
    <div className="flex flex-col border-b border-white/[0.06]">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1 text-xs text-co-text-secondary">
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1
            return (
              <React.Fragment key={i}>
                {i > 0 && (
                  <span className="opacity-50" aria-hidden="true">
                    ›
                  </span>
                )}
                {isLast ? (
                  // §3.7.2 row 6: reveal-in-tree only, never an exit — no
                  // guardAction. It never touches `editing`/`dirty` or the
                  // open file, just syncs the tree's scroll/expansion to the
                  // file that's already open. Fix #141 item 2: only the
                  // filename is a button — `revealInTree` always reveals the
                  // same full open-file path regardless of which segment
                  // triggered it, so making every ancestor segment its own
                  // identical button was N tab stops doing one real action,
                  // with a misleading per-level affordance.
                  <button
                    type="button"
                    className="bg-transparent p-0 hover:underline"
                    onClick={() => revealInTree(selected)}
                    title="Reveal in tree"
                  >
                    <ReviewSafeName name={seg} />
                  </button>
                ) : (
                  <ReviewSafeName name={seg} />
                )}
              </React.Fragment>
            )
          })}
          {dirty && <span aria-label="Unsaved changes" title="Unsaved changes" className="text-co-accent">●</span>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!isDeletedChange &&
            (!editing ? (
              <button
                ref={editButtonRef}
                type="button"
                onClick={() => {
                  if (canEdit) enterEdit()
                }}
                title={editDisabledReason ?? undefined}
                aria-disabled={!canEdit}
              >
                Edit
              </button>
            ) : (
              <>
                <button
                  ref={saveButtonRef}
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || diskChange?.kind === 'deleted'}
                >
                  Save
                </button>
                {/* §3.7.2 row 7: Cancel discards the draft, so it goes through
                    the same guard as every other exit path. */}
                <button
                  type="button"
                  onClick={() => guardAction(cancelEdit, ['code-explorer'])}
                  disabled={saving}
                >
                  Cancel
                </button>
              </>
            ))}
        </div>
      </div>

      <div className="flex items-center gap-4 px-3 pb-1.5 text-xs">
        <div className="flex items-center gap-2" role="group" aria-label="View">
          <span className="text-co-text-muted">View:</span>
          {/* §3.9.1's deleted-change row: Source and Preview aren't options
              for a change with no content — Changes (below) is the only
              view. */}
          {!isDeletedChange && (
            <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>
              Source
            </button>
          )}
          {!isDeletedChange && isPreviewable && (
            <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>
              Preview
            </button>
          )}
          {hasChange && (
            <button
              type="button"
              aria-pressed={view === 'changes'}
              aria-disabled={changesDisabled}
              title={changesDisabledReason ?? undefined}
              onClick={() => {
                if (!changesDisabled) setView('changes')
              }}
            >
              Changes
            </button>
          )}
        </div>

        {view === 'changes' && (
          <div className="flex items-center gap-2" role="group" aria-label="Layout">
            <span className="text-co-text-muted">Layout:</span>
            <button type="button" aria-pressed={diffLayout === 'inline'} onClick={() => setDiffLayout('inline')}>
              Inline
            </button>
            <button type="button" aria-pressed={diffLayout === 'split'} onClick={() => setDiffLayout('split')}>
              Split
            </button>
          </div>
        )}
      </div>

      {/* §3.9.2's disk-change matrix. `diskChange` and `transientNote` are
          editing-only by construction (handleDiskChangeDetected only sets
          them while `state.editing`); `deletedOnDisk` is the view-mode
          counterpart (not editing, content still visible). At most one of
          these is ever non-null at a time. */}
      {diskChange && (
        <ExplorerNotice
          tone="warning"
          role="alert"
          id={`disk-change:${selected}:${diskChange.kind}`}
          message={diskChange.kind === 'modified' ? changedOnDiskBannerMessage() : deletedOnDiskNotice()}
          actions={
            diskChange.kind === 'modified'
              ? [
                  { label: 'Reload', onClick: () => reloadFromDisk() },
                  { label: 'Keep mine', onClick: () => keepMine() },
                ]
              : undefined
          }
        />
      )}
      {transientNote && <ExplorerNotice tone="info" role="status" id={`transient:${selected}`} message={transientNote} />}
      {/* Fix #141 item 1: the visible notice above mounts/unmounts with
          `transientNote` — a freshly-INSERTED `aria-live` region at the same
          moment its content appears is not reliably announced by most
          browser/AT combinations. This region is permanently mounted (its
          own existence never depends on `transientNote`); only its TEXT
          changes, which live regions announce reliably. Visually hidden —
          the visible notice above already serves sighted users. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {transientNote ?? ''}
      </div>
      {deletedOnDisk && (
        <ExplorerNotice tone="warning" role="status" id={`deleted-on-disk:${selected}`} message={deletedOnDiskNotice()} />
      )}
    </div>
  )
}
