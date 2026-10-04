import log from 'electron-log/main'

// ---------------------------------------------------------------------------
// quit-sequence.ts — the async cleanup that runs on `will-quit` (B-H1,
// amendment P2). The hard-exit timer is armed BEFORE any cleanup starts: it
// used to be armed in a `finally` after the cleanup finished, so it bounded
// nothing. Each step is isolated, so one failing step can't skip the rest.
// ---------------------------------------------------------------------------

export const HARD_EXIT_MS = 10_000

export interface QuitSequenceDeps {
  /** Steps run in order; the first is the session teardown (host SIGTERM plus sandbox `stopForQuit`, bounded by its own 5 s race). */
  steps: readonly (() => Promise<void> | void)[]
  exit: (code: number) => void
  hardExitMs?: number
}

export async function runQuitSequence(deps: QuitSequenceDeps): Promise<void> {
  const timer = setTimeout(() => deps.exit(1), deps.hardExitMs ?? HARD_EXIT_MS)
  timer.unref()
  for (const step of deps.steps) {
    try {
      await step()
    } catch (err) {
      log.warn('[Quit] cleanup step failed:', err)
    }
  }
  clearTimeout(timer)
  deps.exit(0)
}
