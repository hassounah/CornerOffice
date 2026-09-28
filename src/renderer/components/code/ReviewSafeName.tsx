import React from 'react'
import { tokenizeName, tokenizeNameToText } from '../../utils/name-safety'

// ---------------------------------------------------------------------------
// ReviewSafeName — the one place a file/directory name is ever rendered
// inline (TRD §3.6.2, joint High). Tree rows (2.11), the breadcrumb (2.13)
// and quick-open results (2.19) all render names through this component so a
// hidden or bidi-control character can never silently reorder or mask what
// the reviewer sees (Trojan-Source-style deception).
//
// Renders inside a <bdi> with `unicode-bidi: isolate` so a bidi override
// inside the name can't also reorder surrounding UI text, and carries the
// full name in `title` — through tokenizeNameToText, never the raw string
// (Fix #124): a native title tooltip is still rendered text, subject to the
// same Unicode bidi algorithm the <bdi> isolation exists to defeat inline,
// so a raw U+202E there would just move the Trojan-Source risk into the
// tooltip instead of removing it. A per-token title on each flagged
// character takes precedence over this when hovering directly over one,
// since it sits on the innermost element.
// ---------------------------------------------------------------------------

export interface ReviewSafeNameProps {
  name: string
  className?: string
  /** False when a caller composes several ReviewSafeName pieces under its
   *  own outer element that already carries the full name as `title` (e.g.
   *  TreeRow's stem/extension split, Fix #123) — avoids a redundant or
   *  misleading per-piece title. Defaults to true (the normal, single-piece
   *  case). */
  titled?: boolean
}

export function ReviewSafeName({ name, className, titled = true }: ReviewSafeNameProps): React.ReactElement {
  const tokens = tokenizeName(name)
  return (
    <bdi className={className} style={{ unicodeBidi: 'isolate' }} title={titled ? tokenizeNameToText(name) : undefined}>
      {tokens.map((token, i) =>
        token.kind === 'text' ? (
          <React.Fragment key={i}>{token.text}</React.Fragment>
        ) : (
          <span
            key={i}
            className="co-invisible-token"
            title={token.title}
            aria-label={token.title}
          >
            {token.placeholder}
          </span>
        ),
      )}
    </bdi>
  )
}
