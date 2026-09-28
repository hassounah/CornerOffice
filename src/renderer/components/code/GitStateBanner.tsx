import React, { useState } from 'react'
import type { RepoInfo } from '@main/types/code'
import { ExplorerNotice } from './ExplorerNotice'
import { gitStateBannerCopy, oldGitVersionNotice, liveUpdatesLimitedNotice } from './notice-copy'

// ---------------------------------------------------------------------------
// GitStateBanner — the single, unified degraded-git-state banner (TRD
// §3.9.1). Sits below the toolbar in both skins. Up to three independent
// notices can apply at once (a repo state issue, the pre-2.39.1 info notice,
// and a live-updates-limited notice), so this renders a small stack rather
// than picking just one.
//
// The Compare control, Changed files and View = Changes stay VISIBLE and
// disabled (with a tooltip repeating the banner's reason) whenever any of
// these apply — that disabling is FileHeader/ExplorerToolbar's job (2.12/
// 2.13), not this component's; GitStateBanner only renders the banner text.
// ---------------------------------------------------------------------------

export interface GitStateBannerProps {
  repo: RepoInfo | null
  /** The raw installed git version string (e.g. "2.34.1"), used only for
   *  the pre-2.39.1 info notice (M5). Not part of RepoInfo itself — the
   *  caller threads it through from git-runner's version probe. */
  gitVersion?: string | null
  /** The specific reason text (notice-copy's LIVE_UPDATES_REASON), supplied
   *  by the caller whenever repo.liveGitUpdates is false. */
  liveUpdatesReason?: string | null
}

export function GitStateBanner({ repo, gitVersion, liveUpdatesReason }: GitStateBannerProps): React.ReactElement | null {
  const [oldVersionDismissed, setOldVersionDismissed] = useState(false)

  if (!repo) return null

  const stateBanner = gitStateBannerCopy(repo.state, repo.stateDetail)
  const showOldVersionNotice = repo.gitVersionInfo === 'pre-2.39.1' && !oldVersionDismissed && !!gitVersion
  const showLiveUpdatesLimited = repo.state === 'git' && repo.liveGitUpdates === false && !!liveUpdatesReason

  if (!stateBanner && !showOldVersionNotice && !showLiveUpdatesLimited) return null

  return (
    <div className="flex flex-col">
      {stateBanner && <ExplorerNotice tone={stateBanner.tone} message={stateBanner.message} />}
      {showLiveUpdatesLimited && (
        <ExplorerNotice tone="info" message={liveUpdatesLimitedNotice(liveUpdatesReason as string)} />
      )}
      {showOldVersionNotice && (
        <ExplorerNotice
          tone="info"
          message={oldGitVersionNotice(gitVersion as string)}
          onDismiss={() => setOldVersionDismissed(true)}
        />
      )}
    </div>
  )
}
