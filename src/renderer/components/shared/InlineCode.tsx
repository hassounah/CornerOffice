import React from 'react'
import { CopyCommand } from '../sandbox/CopyCommand'

// ---------------------------------------------------------------------------
// InlineCode — renders descriptor copy that marks code with backticks (for
// example "`codex` may not be installed: install it with `pnpm add -g ...`")
// as <code>, so no raw backticks reach the screen (#0037 UX-M4). With
// `copyCommands`, a code span that holds a space is a command and gets a
// copy button instead. Plain React text nodes only: the copy is never parsed
// as markup.
// ---------------------------------------------------------------------------

export function InlineCode({
  text,
  copyCommands,
}: {
  text: string
  /** Button styling for the copy buttons; when absent every code span is plain <code>. */
  copyCommands?: { buttonClass: string; buttonStyle?: React.CSSProperties }
}): React.ReactElement {
  const parts = text.split('`')
  // An odd number of backticks leaves the tail unmatched: show it as text.
  const matched = parts.length % 2 === 1 ? parts.length : parts.length - 1
  return (
    <>
      {parts.map((part, i) => {
        if (part === '') return null
        const isCode = i % 2 === 1 && i < matched
        if (!isCode) return <React.Fragment key={i}>{i >= matched && i % 2 === 1 ? `\`${part}` : part}</React.Fragment>
        if (copyCommands && part.includes(' ')) {
          return <CopyCommand key={i} command={part} buttonClass={copyCommands.buttonClass} buttonStyle={copyCommands.buttonStyle} />
        }
        return <code key={i}>{part}</code>
      })}
    </>
  )
}
