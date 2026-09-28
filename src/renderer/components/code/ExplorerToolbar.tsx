import React, { useRef, useState } from 'react'
import type { RepoInfo } from '@main/types/code'
import { useCodeExplorerStore } from '../../stores/code-explorer-store'
import { gitStateBannerCopy } from './notice-copy'
import { RefName } from './RefName'
import { tokenizeNameToText } from '../../utils/name-safety'

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

const BUTTON_COUNT = 7 // Back, Compare (Uncommitted, This branch), Changed files, Show ignored, Refresh/Retry, Go to file

export function ExplorerToolbar({ skin, onBack, onGoToFile }: ExplorerToolbarProps): React.ReactElement {
  const repo = useCodeExplorerStore((s) => s.repo)
  const baseline = useCodeExplorerStore((s) => s.baseline)
  const changedOnly = useCodeExplorerStore((s) => s.changedOnly)
  const showIgnored = useCodeExplorerStore((s) => s.showIgnored)
  const status = useCodeExplorerStore((s) => s.status)
  const setBaseline = useCodeExplorerStore((s) => s.setBaseline)
  const setChangedOnly = useCodeExplorerStore((s) => s.setChangedOnly)
  const setShowIgnored = useCodeExplorerStore((s) => s.setShowIgnored)
  const refreshStatus = useCodeExplorerStore((s) => s.refreshStatus)

  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [focusedIndex, setFocusedIndex] = useState(0)

  function refForIndex(index: number) {
    return (el: HTMLButtonElement | null) => {
      buttonRefs.current[index] = el
    }
  }

  function focusIndex(index: number): void {
    setFocusedIndex(index)
    buttonRefs.current[index]?.focus()
  }

  // ←/→ roving tabindex between every control in the toolbar (§3.6.3).
  function handleToolbarKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' ? 1 : -1
    focusIndex((focusedIndex + delta + BUTTON_COUNT) % BUTTON_COUNT)
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

  return (
    <div role="toolbar" aria-label="Explorer" onKeyDown={handleToolbarKeyDown} className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <button
          ref={refForIndex(0)}
          type="button"
          tabIndex={focusedIndex === 0 ? 0 : -1}
          onFocus={() => setFocusedIndex(0)}
          onClick={onBack}
        >
          {BACK_LABEL[skin]}
        </button>
        {branchLabel && (
          <span className="flex items-center gap-1">
            {branchLabel.prefix}
            <RefName name={branchLabel.name} />
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span>Compare:</span>
        <button
          ref={refForIndex(1)}
          type="button"
          tabIndex={focusedIndex === 1 ? 0 : -1}
          onFocus={() => setFocusedIndex(1)}
          aria-pressed={baseline === 'head'}
          aria-disabled={uncommittedDisabled}
          title={uncommittedTitle}
          onClick={() => {
            if (!uncommittedDisabled) setBaseline('head')
          }}
        >
          Uncommitted
        </button>
        <button
          ref={refForIndex(2)}
          type="button"
          tabIndex={focusedIndex === 2 ? 0 : -1}
          onFocus={() => setFocusedIndex(2)}
          aria-pressed={baseline === 'branch'}
          aria-disabled={thisBranchDisabled}
          title={thisBranchTitle}
          onClick={() => {
            if (!thisBranchDisabled) setBaseline('branch')
          }}
        >
          This branch
        </button>

        <button
          ref={refForIndex(3)}
          type="button"
          tabIndex={focusedIndex === 3 ? 0 : -1}
          onFocus={() => setFocusedIndex(3)}
          aria-pressed={changedOnly}
          aria-disabled={changedFilesDisabled}
          title={changedFilesTitle}
          onClick={() => {
            if (!changedFilesDisabled) setChangedOnly(!changedOnly)
          }}
        >
          {changedOnly ? '✓ ' : ''}Changed files · {changedFilesCount}
        </button>

        <button
          ref={refForIndex(4)}
          type="button"
          tabIndex={focusedIndex === 4 ? 0 : -1}
          onFocus={() => setFocusedIndex(4)}
          aria-pressed={showIgnored}
          title={showIgnoredTitle}
          onClick={() => setShowIgnored(!showIgnored)}
        >
          {SHOW_IGNORED_LABEL[skin]}
        </button>

        <button
          ref={refForIndex(5)}
          type="button"
          tabIndex={focusedIndex === 5 ? 0 : -1}
          onFocus={() => setFocusedIndex(5)}
          title={refreshTitle}
          aria-label={isRetry ? 'Retry' : 'Refresh'}
          className={isRetry ? 'text-co-status-waiting' : undefined}
          onClick={() => void refreshStatus()}
        >
          {isRetry ? '⟳ Retry' : '⟳'}
        </button>
      </div>

      <div>
        <button
          ref={refForIndex(6)}
          type="button"
          tabIndex={focusedIndex === 6 ? 0 : -1}
          onFocus={() => setFocusedIndex(6)}
          title="Go to file (Ctrl+P)"
          onClick={onGoToFile}
        >
          {'⌕'} Go to file <span className="opacity-60">Ctrl+P</span>
        </button>
      </div>
    </div>
  )
}
