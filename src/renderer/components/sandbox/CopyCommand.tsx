import React, { useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// CopyCommand — a command to run, with a copy button that has a name and a
// polite "Copied" confirmation (#0037 D11, UX-H2). Used where a sandbox
// readiness problem has a fix on the command line (for example `codex login`).
// The live region exists before the confirmation does, so it is announced; a
// failed copy says "Couldn't copy" there instead of staying silent (L12).
// ---------------------------------------------------------------------------

const COPIED_VISIBLE_MS = 2_000

export function CopyCommand({
  command,
  buttonClass,
  buttonStyle,
}: {
  command: string
  buttonClass: string
  buttonStyle?: React.CSSProperties
}): React.ReactElement {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  async function copy(): Promise<void> {
    let outcome: 'copied' | 'failed' = 'copied'
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      outcome = 'failed' // nothing was copied: say so, and the command stays selectable beside the button
    }
    setResult(outcome)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setResult(null), COPIED_VISIBLE_MS)
  }

  return (
    <span className="inline-flex items-center gap-2">
      <code>{command}</code>
      <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void copy()} aria-label={`Copy command ${command}`}>
        Copy
      </button>
      <span role="status" aria-live="polite" data-testid="copy-confirmation" className="text-xs">
        {result === 'copied' ? 'Copied' : result === 'failed' ? "Couldn't copy" : ''}
      </span>
    </span>
  )
}
