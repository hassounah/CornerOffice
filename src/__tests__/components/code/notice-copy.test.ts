import { describe, it, expect } from 'vitest'
import {
  gitStateBannerCopy,
  oldGitVersionNotice,
  unsafeRepoRootMessage,
  LIVE_UPDATES_REASON,
  liveUpdatesLimitedNotice,
  reloadedFromDiskNotice,
  deletedOnDiskNotice,
  changedOnDiskBannerMessage,
  baseVersionUnavailableNotice,
  invisibleCharsSummaryNotice,
  formatByteCount,
  binaryFileChangedNotice,
  tooLargeToCompareNotice,
  eolOnlyChangeNotice,
  secretDiffNotice,
} from '../../../renderer/components/code/notice-copy'
import type { RepoState } from '../../../main/types/code'

describe('gitStateBannerCopy', () => {
  it("returns null for 'git' (no degraded condition)", () => {
    expect(gitStateBannerCopy('git', null)).toBeNull()
  })

  it("not-git shows the 'not a git repository' info banner", () => {
    expect(gitStateBannerCopy('not-git', null)).toEqual({
      tone: 'info',
      message: "Review features are off: this folder isn't a git repository.",
    })
  })

  it('git-unavailable with no stateDetail shows the generic "wasn\'t found" warning', () => {
    expect(gitStateBannerCopy('git-unavailable', null)).toEqual({
      tone: 'warning',
      message: "Review features are off: git wasn't found.",
    })
  })

  it("git-unavailable with 'git found inside a workspace' shows the specific warning", () => {
    expect(gitStateBannerCopy('git-unavailable', 'git found inside a workspace')).toEqual({
      tone: 'warning',
      message: "Review features are off: git was found inside a workspace and won't be run.",
    })
  })

  it('git-too-old shows an info banner', () => {
    expect(gitStateBannerCopy('git-too-old', null)).toEqual({
      tone: 'info',
      message: 'Review features are off: git 2.31 or newer is needed.',
    })
  })

  it('git-untrusted shows a warning', () => {
    expect(gitStateBannerCopy('git-untrusted', null)).toEqual({
      tone: 'warning',
      message: "Review features are off: git doesn't trust this folder (owned by another user).",
    })
  })

  it('git-unsafe shows a warning', () => {
    expect(gitStateBannerCopy('git-unsafe', null)).toEqual({
      tone: 'warning',
      message:
        "Review features are off: this repository's git configuration changed unexpectedly or couldn't be checked.",
    })
  })

  it('root-mismatch shows a warning', () => {
    expect(gitStateBannerCopy('root-mismatch', null)).toEqual({
      tone: 'warning',
      message: "Review features are off: the workspace isn't the top of its git repository.",
    })
  })

  it('covers every RepoState with no runtime default fallthrough', () => {
    const states: RepoState[] = [
      'git',
      'not-git',
      'git-unavailable',
      'git-too-old',
      'git-untrusted',
      'git-unsafe',
      'root-mismatch',
    ]
    for (const state of states) {
      expect(() => gitStateBannerCopy(state, null)).not.toThrow()
    }
  })
})

describe('oldGitVersionNotice', () => {
  it('interpolates the version (M5)', () => {
    expect(oldGitVersionNotice('2.34.1')).toBe(
      "Your git (2.34.1) predates 2.39.1. If your system hasn't backported security fixes, consider updating."
    )
  })
})

describe('unsafeRepoRootMessage', () => {
  it('returns the fixed M3 message', () => {
    expect(unsafeRepoRootMessage()).toBe('The code explorer is disabled for your home folder or a drive root.')
  })
})

describe('liveUpdatesLimitedNotice (§D-11 — one string with a reason)', () => {
  it('interpolates the unusual-.git-layout reason', () => {
    expect(liveUpdatesLimitedNotice(LIVE_UPDATES_REASON.UNUSUAL_GIT_LAYOUT)).toBe(
      'Live updates are limited: this repository has an unusual .git layout. Markers refresh every 10 s.'
    )
  })

  it('interpolates the folder-cap reason', () => {
    expect(liveUpdatesLimitedNotice(LIVE_UPDATES_REASON.FOLDER_CAP)).toBe(
      'Live updates are limited: showing the 256 most recent folders. Markers refresh every 10 s.'
    )
  })
})

describe('disk-change matrix copy (§3.9.2)', () => {
  it('reloadedFromDiskNotice', () => {
    expect(reloadedFromDiskNotice()).toBe('Reloaded from disk')
  })
  it('deletedOnDiskNotice', () => {
    expect(deletedOnDiskNotice()).toBe('Deleted on disk')
  })
  it('changedOnDiskBannerMessage', () => {
    // Fix #141 item 5: no longer repeats the action names — the Reload/Keep
    // mine buttons already render right next to this text.
    expect(changedOnDiskBannerMessage()).toBe('Changed on disk')
  })
  it('baseVersionUnavailableNotice', () => {
    expect(baseVersionUnavailableNotice()).toBe('Base version not available locally (partial clone).')
  })
})

describe('DiffView card copy (§3.6.8)', () => {
  it('formatByteCount pluralizes and adds thousands separators', () => {
    expect(formatByteCount(0)).toBe('0 bytes')
    expect(formatByteCount(1)).toBe('1 byte')
    expect(formatByteCount(2048)).toBe('2,048 bytes')
  })

  it('binaryFileChangedNotice formats both sides', () => {
    expect(binaryFileChangedNotice(1024, 2048)).toBe('Binary file changed (1,024 bytes → 2,048 bytes)')
  })

  it('tooLargeToCompareNotice returns the fixed string', () => {
    expect(tooLargeToCompareNotice()).toBe('Too large to compare.')
  })

  it('eolOnlyChangeNotice formats both EOL labels', () => {
    expect(eolOnlyChangeNotice('lf', 'crlf')).toBe('Only line endings changed (LF → CRLF)')
    expect(eolOnlyChangeNotice('crlf', 'lf')).toBe('Only line endings changed (CRLF → LF)')
    expect(eolOnlyChangeNotice('none', 'mixed')).toBe('Only line endings changed (No line endings → Mixed)')
  })
})

describe('secretDiffNotice (Fix #135 item 3)', () => {
  it('names the original side when only the original is secret', () => {
    expect(secretDiffNotice('original')).toBe('The previous version of this file may contain secrets. Contents hidden.')
  })

  it('names the current side when only the current is secret', () => {
    expect(secretDiffNotice('current')).toBe('The current version of this file may contain secrets. Contents hidden.')
  })

  it('names both sides when both are secret', () => {
    expect(secretDiffNotice('both')).toBe('Both versions of this file may contain secrets. Contents hidden.')
  })
})

describe('invisibleCharsSummaryNotice (§3.6.6)', () => {
  it('formats a single occurrence with no "+more" suffix', () => {
    expect(invisibleCharsSummaryNotice('U+202E', 12, 0)).toBe(
      'This file contains invisible or bidirectional characters (U+202E at line 12)'
    )
  })

  it('formats multiple occurrences with the "+more" suffix', () => {
    expect(invisibleCharsSummaryNotice('U+202E', 12, 2)).toBe(
      'This file contains invisible or bidirectional characters (U+202E at line 12, +2 more)'
    )
  })
})
