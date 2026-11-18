/** Error code carried by the rejection when a deadline elapses. */
export const TIMEOUT_CODE = 'TIMEOUT'

/** Fixed, path-free message (Sec M1): never interpolate a path or an inner error. */
export const TIMEOUT_MESSAGE = 'Timed out'

export class DeadlineError extends Error {
  readonly code = TIMEOUT_CODE

  constructor() {
    super(TIMEOUT_MESSAGE)
    this.name = 'DeadlineError'
  }
}

export interface DeadlineOptions {
  /** Called once, with the still-pending promise, when the deadline wins the race. */
  onOrphan?: (orphan: Promise<unknown>) => void
}

const noop = (): void => {}

/**
 * Race `p` against a timer. Rejects with a `DeadlineError` (code `TIMEOUT`) when `ms`
 * elapses first. The timer is always cleared. A promise that loses the race is
 * "orphaned": it keeps running (a hung fs call cannot be cancelled), so it is
 * reported to `onOrphan` for outstanding-call accounting, and its later rejection
 * is swallowed here so it cannot surface as an unhandled rejection.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, options: DeadlineOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      p.then(noop, noop)
      options.onOrphan?.(p)
      reject(new DeadlineError())
    }, ms)

    p.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
