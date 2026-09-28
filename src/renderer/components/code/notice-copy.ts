import type { RepoState } from '@main/types/code'

// ---------------------------------------------------------------------------
// notice-copy.ts — the single source of ExplorerNotice / GitStateBanner copy
// (TRD §3.9.1, §3.9.2, §3.6.6, §D-11). GitStateBanner (2.10) and the disk-
// change UI (2.6/2.7/2.16) render these strings; they never inline their own.
// ---------------------------------------------------------------------------

export type NoticeTone = 'info' | 'warning'

export interface GitBannerCopy {
  tone: NoticeTone
  message: string
}

/**
 * Fixed copy for the unified GitStateBanner, keyed by `RepoInfo.state` (TRD
 * §3.9.1's table). Returns null for `'git'` with no degraded condition —
 * callers still separately check `gitVersionInfo` via `oldGitVersionNotice`.
 * `stateDetail` distinguishes the two `git-unavailable` causes.
 */
export function gitStateBannerCopy(state: RepoState, stateDetail: string | null): GitBannerCopy | null {
  switch (state) {
    case 'git':
      return null
    case 'not-git':
      return { tone: 'info', message: "Review features are off: this folder isn't a git repository." }
    case 'git-unavailable':
      return stateDetail === 'git found inside a workspace'
        ? {
            tone: 'warning',
            message: "Review features are off: git was found inside a workspace and won't be run.",
          }
        : { tone: 'warning', message: "Review features are off: git wasn't found." }
    case 'git-too-old':
      return { tone: 'info', message: 'Review features are off: git 2.31 or newer is needed.' }
    case 'git-untrusted':
      return {
        tone: 'warning',
        message: "Review features are off: git doesn't trust this folder (owned by another user).",
      }
    case 'git-unsafe':
      return {
        tone: 'warning',
        message:
          "Review features are off: this repository's git configuration changed unexpectedly or couldn't be checked.",
      }
    case 'root-mismatch':
      return { tone: 'warning', message: "Review features are off: the workspace isn't the top of its git repository." }
  }
}

/** M5: informational only, non-blocking — git works, but predates the CVE-2022-23521 fix. */
export function oldGitVersionNotice(version: string): string {
  return `Your git (${version}) predates 2.39.1. If your system hasn't backported security fixes, consider updating.`
}

/** Shown on the page itself when repoRootStatus === 'unsafe' (M3) — nothing is served. */
export function unsafeRepoRootMessage(): string {
  return 'The code explorer is disabled for your home folder or a drive root.'
}

// One string with a reason (§D-11) — used whenever gitDir validation fails or a watch cap is hit.
export const LIVE_UPDATES_REASON = {
  UNUSUAL_GIT_LAYOUT: 'this repository has an unusual .git layout',
  FOLDER_CAP: 'showing the 256 most recent folders',
} as const

export function liveUpdatesLimitedNotice(reason: string): string {
  return `Live updates are limited: ${reason}. Markers refresh every 10 s.`
}

// --- §3.9.2 disk-change matrix ---------------------------------------------

/** Transient notice (role="status", auto-hides after 4 s) — editing ∧ clean, reloaded in place. */
export function reloadedFromDiskNotice(): string {
  return 'Reloaded from disk'
}

/** Persistent notice — view mode, file deleted on disk. */
export function deletedOnDiskNotice(): string {
  return 'Deleted on disk'
}

/** Persistent banner — editing ∧ dirty, file modified on disk (also shown on a raced STALE_WRITE).
 *  Fix #141 item 5: the action names used to be repeated here, but the
 *  "Reload"/"Keep mine" buttons already render right next to this text. */
export function changedOnDiskBannerMessage(): string {
  return 'Changed on disk'
}

/** Changes-card copy when the baseline blob is missing locally (partial clone, no fetch).
 *  Fix #135 item 4: restores TRD §3.6.8's parenthetical, which explains WHY
 *  (a shallow/partial clone lacks the object needed to fetch the baseline) —
 *  actionable context, consistent with this feature's disabled-with-reason
 *  copy standard elsewhere. */
export function baseVersionUnavailableNotice(): string {
  return 'Base version not available locally (partial clone).'
}

// --- §3.6.8 Changes view (DiffView) cards -----------------------------------

/** Whole-number byte count with thousands separators, e.g. "2,048 bytes". */
export function formatByteCount(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`
}

// --- §3.6.4 CodePane per-kind notices ---------------------------------------

/** "Opened read-only: <reason>" (info) — the text + readOnlyReason row.
 *  Distinct copy from FileHeader's own Edit-button tooltip (2.13), which
 *  answers a different question ("why can't I click Edit") for the same
 *  `readOnlyReason` values. */
export function readOnlyReasonNotice(reason: 'too-large' | 'encoding' | 'mixed-eol' | 'symlink'): string {
  switch (reason) {
    case 'too-large':
      return 'Opened read-only: larger than 2 MB (highlighting off)'
    case 'encoding':
      return 'Opened read-only: not valid UTF-8'
    case 'mixed-eol':
      return 'Opened read-only: mixed line endings'
    case 'symlink':
      return 'Opened read-only: symlink — edit the target'
  }
}

/** Warning notice for an unrevealed secret file — exact wireframe copy (§3.6.3). */
export function secretFileNotice(): string {
  return 'This file may contain secrets. Contents hidden.'
}

/** "too-large" file.kind (over 10 MB) — never opened at all. */
export function tooLargeToDisplayNotice(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10
  return `Too large to display (${rounded} MB)`
}

/** Fix #133: the live-region announcement CodePane's image branch reads out
 *  on landing (role="status"), since the <img> itself has no other text
 *  content a screen reader would announce on its own. `name` must already
 *  be review-safe (the caller tokenizes it via tokenizeNameToText first),
 *  matching every other consumer of that helper. */
export function imagePreviewAnnouncement(name: string): string {
  return `Image preview: ${name}`
}

/** Fix #133: ImagePreview's onError fallback — a corrupt/undecodable image
 *  must not degrade silently to a blank broken-image icon (TRD §3.1
 *  principle 6). */
export function imageLoadFailedNotice(): string {
  return "Couldn't load image preview"
}

/** Fix #135 item 3: the Changes-card copy for a secret side, naming WHICH
 *  side(s) are hidden — plain `secretFileNotice()` (single-file CodePane)
 *  doesn't have a "side" to name, so this is a distinct function rather than
 *  a parameter added to that one. */
export function secretDiffNotice(which: 'original' | 'current' | 'both'): string {
  switch (which) {
    case 'original':
      return 'The previous version of this file may contain secrets. Contents hidden.'
    case 'current':
      return 'The current version of this file may contain secrets. Contents hidden.'
    case 'both':
      return 'Both versions of this file may contain secrets. Contents hidden.'
  }
}

/** Changes-card copy when either side is binary. */
export function binaryFileChangedNotice(beforeBytes: number, afterBytes: number): string {
  return `Binary file changed (${formatByteCount(beforeBytes)} → ${formatByteCount(afterBytes)})`
}

/** Changes-card copy when either side is over the compare size cap. */
export function tooLargeToCompareNotice(): string {
  return 'Too large to compare.'
}

const EOL_LABEL: Record<'lf' | 'crlf' | 'none' | 'mixed', string> = {
  lf: 'LF',
  crlf: 'CRLF',
  none: 'No line endings',
  mixed: 'Mixed',
}

/** Changes-card copy when the two sides differ only by line-ending style (text-utils.ts's eolOnlyChange). */
export function eolOnlyChangeNotice(from: 'lf' | 'crlf' | 'none' | 'mixed', to: 'lf' | 'crlf' | 'none' | 'mixed'): string {
  return `Only line endings changed (${EOL_LABEL[from]} → ${EOL_LABEL[to]})`
}

// --- §3.6.6 review-safety summary notice -----------------------------------

/** "This file contains invisible or bidirectional characters (U+202E at line 12, +2 more)" */
export function invisibleCharsSummaryNotice(firstLabel: string, firstLine: number, extraCount: number): string {
  const suffix = extraCount > 0 ? `, +${extraCount} more` : ''
  return `This file contains invisible or bidirectional characters (${firstLabel} at line ${firstLine}${suffix})`
}
