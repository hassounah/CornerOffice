// ---------------------------------------------------------------------------
// display-path.ts — a path as the user reads it (#0039, TRD §4.9): the home directory shown as `~`. Display only: the
// renderer never builds a path to act on, it only sends scalars and reads what main sends.
//
// The renderer does not know the home directory (main never sends it), so the usual macOS and Linux shapes are
// recognised: `/Users/<name>` and `/home/<name>`. Any other path is shown as it is.
// ---------------------------------------------------------------------------

const HOME_PREFIX = /^(?:\/Users|\/home)\/[^/]+(?=\/|$)/

/** `/home/amer/projects/api` -> `~/projects/api`; `/srv/api` stays as it is. */
export function homeRelative(path: string): string {
  return path.replace(HOME_PREFIX, '~')
}

/**
 * The home directory, read off the first path that sits under one (`/home/amer/x` -> `/home/amer`), or null when none
 * does. Used only to pre-fill a folder the user can change; the dialog's folder picker always starts at the real home.
 */
export function inferHomeDir(paths: readonly string[]): string | null {
  for (const p of paths) {
    const match = HOME_PREFIX.exec(p)
    if (match) return match[0]
  }
  return null
}
