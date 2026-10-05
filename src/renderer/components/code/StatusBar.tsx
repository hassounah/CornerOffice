import React from 'react'
import { isMac } from '../../utils/platform'

// ---------------------------------------------------------------------------
// StatusBar — the §3.6.3 wireframe's bottom bar (TRD §3.6.3 "Mod-G
// affordance"): "Ln 42, Col 7 · UTF-8 · LF · Ctrl+G go to line · F3 next
// match", with the Mod-G hint spelled per platform (⌘ on macOS). Pure and
// store-agnostic — SourceView (2.16) reports cursor position via
// onCursorChange; CodePane (2.17) threads file.encoding/eol straight through.
// ---------------------------------------------------------------------------

export interface StatusBarProps {
  line: number
  col: number
  encoding: 'utf-8' | 'utf-8-lossy' | 'utf-16le' | 'utf-16be'
  eol: 'lf' | 'crlf' | 'none' | 'mixed'
}

const ENCODING_LABEL: Record<StatusBarProps['encoding'], string> = {
  'utf-8': 'UTF-8',
  'utf-8-lossy': 'UTF-8 (lossy)',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
}

const EOL_LABEL: Record<StatusBarProps['eol'], string> = {
  lf: 'LF',
  crlf: 'CRLF',
  none: '—',
  mixed: 'Mixed',
}

function gotoLineHint(): string {
  return isMac() ? '⌘G go to line' : 'Ctrl+G go to line'
}

export function StatusBar({ line, col, encoding, eol }: StatusBarProps): React.ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-white/[0.06] px-3 py-1 text-xs text-co-text-muted">
      <span>
        Ln {line}, Col {col}
      </span>
      <span aria-hidden="true">·</span>
      <span>{ENCODING_LABEL[encoding]}</span>
      <span aria-hidden="true">·</span>
      <span>{EOL_LABEL[eol]}</span>
      <span aria-hidden="true">·</span>
      <span>{gotoLineHint()} · F3 next match</span>
    </div>
  )
}
