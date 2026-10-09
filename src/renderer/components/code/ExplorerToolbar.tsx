import React, { useCallback, useId, useRef, useState } from 'react'
import type { RepoInfo } from '@main/types/code'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { useSandboxStore } from '../../stores/sandbox-store'
import { guardAction } from '../../stores/dirty-registry'
import { gitStateBannerCopy } from './notice-copy'
import { RefName } from './RefName'
import { tokenizeNameToText } from '../../utils/name-safety'
import { FilterChip, SegmentedControl, Spinner, ToolbarButton } from './ToolbarControls'

// ---------------------------------------------------------------------------
// ExplorerToolbar — the §3.6.3 wireframe's toolbar (TRD §3.6.3, H-U2, U-L2,
// U-L3; UX H1, Sec M-5). Reads scope state (baseline/changedOnly/
// showIgnored/status/repo) straight from the code-explorer-store, its own
// natural owner (2.6) — same convention as FileTree (2.11). `onBack` and
// `onGoToFile` are the only two things this toolbar doesn't own: exiting the
// explorer (routing, 2.13) and Quick-open (2.19).
//
// Joint ownership with 2.13 (agreed at Gate 2): this file, together with
// FileHeader's View = Changes control, must disable-with-reason every
// git-dependent control for every RepoState — never hide it — with a
// tooltip that repeats the GitStateBanner reason.
//
// Controls are the shared ToolbarControls primitives (#0036), so every
// control looks clickable in both skins; a user-initiated refresh shows its
// pending state (spinner on the control that caused it) via the store's
// `statusPending`, which background polls never set.
// ---------------------------------------------------------------------------

export interface ExplorerToolbarProps {
  skin: 'office' | 'realm'
  onBack: () => void
  onGoToFile: () => void
}

// TRD §3.8.2's "Copy decision": Realm keeps themed copy for NAVIGATION AND
// CHROME only — these two labels are the only ones the TRD names verbatim.
// Everything else in this toolbar (Compare, Changed files, Refresh/Retry,
// Go to file) stays exactly as-is in both skins; security/degraded copy
// elsewhere (GitStateBanner, notice-copy.ts) is untouched by `skin`
// entirely, by design (step 3.2's "clean code pane").
const BACK_LABEL: Record<'office' | 'realm', string> = {
  office: '← Back',
  realm: 'Return to the Study',
}
const SHOW_IGNORED_LABEL: Record<'office' | 'realm', string> = {
  office: 'Show ignored',
  realm: 'Unscroll ignored tomes',
}

type BaseUnavailableReason = 'no-commits' | 'no-base-branch' | 'no-merge-base' | 'not-git'

// FR-19: "if none resolvable, the branch option is disabled with an
// explanation." No fixed wording is prescribed elsewhere, so this is
// authored here, alongside the one control it applies to.
const BASE_UNAVAILABLE_COPY: Record<BaseUnavailableReason, string> = {
  'no-commits': 'No commits yet',
  'no-base-branch': 'No base branch found (tried main, master, origin/HEAD)',
  'no-merge-base': 'No merge base found with the base branch',
  'not-git': "This folder isn't a git repository",
}

function baseUnavailableReasonText(repo: RepoInfo): string | null {
  return repo.base.available ? null : BASE_UNAVAILABLE_COPY[repo.base.reason]
}

const BASE_BUTTON_COUNT = 7 // Back, Compare (Uncommitted, This branch), Changed files, Show ignored, Refresh/Retry, Go to file
const ROOT_TOGGLE_COUNT = 2 // Workspace | Sandbox, appended after the base buttons when a sandbox exists

export function ExplorerToolbar({ skin, onBack, onGoToFile }: ExplorerToolbarProps): React.ReactElement {
  const repo = useCodeExplorerStore((s) => s.repo)
  const baseline = useCodeExplorerStore((s) => s.baseline)
  const changedOnly = useCodeExplorerStore((s) => s.changedOnly)
  const showIgnored = useCodeExplorerStore((s) => s.showIgnored)
  const status = useCodeExplorerStore((s) => s.status)
  const statusPending = useCodeExplorerStore((s) => s.statusPending)
  const setBaseline = useCodeExplorerStore((s) => s.setBaseline)
  const setChangedOnly = useCodeExplorerStore((s) => s.setChangedOnly)
  const setShowIgnored = useCodeExplorerStore((s) => s.setShowIgnored)
  const refreshStatus = useCodeExplorerStore((s) => s.refreshStatus)
  const root = useCodeExplorerStore((s) => s.root)
  const setRoot = useCodeExplorerStore((s) => s.setRoot)
  const slug = useCodeExplorerStore((s) => s.workspaceSlug)
  // The toggle exists only for a workspace that has a sandbox (TRD §3.10).
  const hasSandbox = useSandboxStore((s) => (slug ? (s.summaries[slug]?.exists ?? false) : false))
  const buttonCount = BASE_BUTTON_COUNT + (hasSandbox ? ROOT_TOGGLE_COUNT : 0)

  const compareId = useId()
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusedIndex, setFocusedIndex] = useState(0)
  const refFor = useCallback(
    (i: number) => (el: HTMLButtonElement | null) => {
      buttonRefs.current[i] = el
    },
    [],
  )

  function focusIndex(index: number): void {
    setFocusedIndex(index)
    buttonRefs.current[index]?.focus()
  }

  // ←/→ roving tabindex between every control in the toolbar (§3.6.3).
  function handleToolbarKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' ? 1 : -1
    focusIndex((focusedIndex + delta + buttonCount) % buttonCount)
  }

  const gitBanner = repo ? gitStateBannerCopy(repo.state, repo.stateDetail) : null
  // Layer 1: the whole repo state is degraded — disables Compare (both
  // options) and Changed files. Tooltip repeats the GitStateBanner reason.
  const repoDisabledReason = gitBanner?.message ?? null
  // Layer 2: git itself is fine, but the base branch couldn't be resolved
  // (FR-19) — disables only the "This branch" option.
  const baseReason = repo ? baseUnavailableReasonText(repo) : null

  const uncommittedDisabled = repoDisabledReason !== null
  const uncommittedTitle = repoDisabledReason ?? 'Working tree vs HEAD (Alt+Shift+B to toggle)'

  const thisBranchDisabledReason = repoDisabledReason ?? baseReason
  const thisBranchDisabled = thisBranchDisabledReason !== null
  const thisBranchTitle =
    thisBranchDisabledReason ??
    (repo?.base.available
      ? `Working tree vs merge-base with ${tokenizeNameToText(repo.base.name)} (Alt+Shift+B to toggle)`
      : '')

  const changedFilesDisabled = repoDisabledReason !== null
  const changedFilesCount = status?.changes.length ?? 0
  const changedFilesTitle = repoDisabledReason ?? 'Alt+Shift+C'

  const showIgnoredTitle = 'Alt+Shift+I'

  const isRetry = status?.failed === true
  const refreshTitle = isRetry ? 'Status out of date — retry (F5)' : 'Refresh (F5)'

  const branchLabel = repo?.detached
    ? { prefix: 'detached at ', name: repo.headShort ?? '' }
    : repo?.branch
      ? { prefix: '⎇ ', name: repo.branch } // U+2387 ALTERNATIVE KEY SYMBOL, stands in for the branch glyph
      : null

  const rove = (i: number) => ({
    tabIndex: focusedIndex === i ? 0 : -1,
    onFocus: () => setFocusedIndex(i),
  })

  const refreshBusy = statusPending === 'refresh'

  return (
    <div
      role="toolbar"
      aria-label="Explorer"
      data-skin={skin}
      onKeyDown={handleToolbarKeyDown}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ToolbarButton skin={skin} variant="ghost" ref={refFor(0)} {...rove(0)} onClick={onBack}>
          {skin === 'realm' && <span aria-hidden="true">←</span>}
          {BACK_LABEL[skin]}
        </ToolbarButton>
        {branchLabel && (
          // Truncates long names; the title carries the full name, tokenized so no raw bidi/invisible character reaches it.
          <span className="co-tb co-tb-info" data-skin={skin} title={`${branchLabel.prefix}${tokenizeNameToText(branchLabel.name)}`}>
            {branchLabel.prefix}
            <RefName name={branchLabel.name} />
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span id={compareId} className="co-tb co-tb-label" data-skin={skin}>
          Compare:
        </span>
        <SegmentedControl skin={skin} aria-labelledby={compareId}>
          <ToolbarButton
            skin={skin}
            variant="segment"
            ref={refFor(1)} {...rove(1)}
            busy={statusPending === 'baseline' && baseline === 'head'}
            aria-pressed={baseline === 'head'}
            aria-disabled={uncommittedDisabled}
            title={uncommittedTitle}
            onClick={() => {
              if (!uncommittedDisabled) setBaseline('head')
            }}
          >
            {statusPending === 'baseline' && baseline === 'head' && <Spinner />}
            <span>Uncommitted</span>
          </ToolbarButton>
          <ToolbarButton
            skin={skin}
            variant="segment"
            ref={refFor(2)} {...rove(2)}
            busy={statusPending === 'baseline' && baseline === 'branch'}
            aria-pressed={baseline === 'branch'}
            aria-disabled={thisBranchDisabled}
            title={thisBranchTitle}
            onClick={() => {
              if (!thisBranchDisabled) setBaseline('branch')
            }}
          >
            {statusPending === 'baseline' && baseline === 'branch' && <Spinner />}
            <span>This branch</span>
          </ToolbarButton>
        </SegmentedControl>

        <FilterChip
          skin={skin}
          ref={refFor(3)} {...rove(3)}
          pressed={changedOnly}
          count={changedFilesCount}
          aria-disabled={changedFilesDisabled}
          title={changedFilesTitle}
          onClick={() => {
            if (!changedFilesDisabled) setChangedOnly(!changedOnly)
          }}
        >
          Changed files
        </FilterChip>

        <FilterChip
          skin={skin}
          ref={refFor(4)}
          {...rove(4)}
          pressed={showIgnored}
          title={showIgnoredTitle}
          onClick={() => setShowIgnored(!showIgnored)}
        >
          {SHOW_IGNORED_LABEL[skin]}
        </FilterChip>

        <ToolbarButton
          skin={skin}
          variant={isRetry ? 'pill' : 'icon'}
          tone={isRetry ? 'warning' : undefined}
          ref={refFor(5)} {...rove(5)}
          busy={refreshBusy}
          title={refreshTitle}
          aria-label={isRetry ? 'Retry' : 'Refresh'}
          onClick={() => void refreshStatus('refresh')}
        >
          <span aria-hidden="true" className={refreshBusy ? 'co-tb-spin' : undefined}>
            ⟳
          </span>
          {isRetry && 'Retry'}
        </ToolbarButton>
      </div>

      <div>
        <ToolbarButton skin={skin} variant="search" ref={refFor(6)} {...rove(6)} title="Go to file (Ctrl+P)" onClick={onGoToFile}>
          <span aria-hidden="true">⌕</span>
          Go to file
          <kbd className="co-tb-kbd">Ctrl+P</kbd>
        </ToolbarButton>
      </div>

      {hasSandbox && (
        <SegmentedControl skin={skin} aria-label="Tree">
          {(['workspace', 'sandbox'] as const).map((target, i) => {
            const busy = statusPending === 'root' && root === target
            return (
              <ToolbarButton
                key={target}
                skin={skin}
                variant="segment"
                ref={refFor(BASE_BUTTON_COUNT + i)} {...rove(BASE_BUTTON_COUNT + i)}
                busy={busy}
                aria-pressed={root === target}
                onClick={() => {
                  // Switching trees closes and reopens the session, which would discard an unsaved edit: same guard as every other exit.
                  if (root !== target) guardAction(() => setRoot(target), ['code-explorer'])
                }}
              >
                {busy && <Spinner />}
                <span>{target === 'workspace' ? 'Workspace' : 'Sandbox'}</span>
              </ToolbarButton>
            )
          })}
        </SegmentedControl>
      )}
    </div>
  )
}
