import React from 'react'
import { ReviewSafeName } from './ReviewSafeName'

// ---------------------------------------------------------------------------
// RefName — review-safe rendering for a git ref (branch or base) name (TRD
// §3.6.3, Sec M-5). Same <bdi> + tokenizeName treatment as ReviewSafeName
// (file/directory names, §3.6.2) — reused here under a ref-specific name for
// call-site clarity wherever a branch or base name appears: the toolbar's
// branch chip and "detached at …" (2.12), the Compare "This branch"
// tooltip's base name (2.12, via name-safety.ts's tokenizeNameToText — a
// title attribute cannot hold a React element), and the branch-mismatch
// banner (2.13).
//
// Component-only file (react-refresh/only-export-components): the plain-text
// variant used for title attributes lives in name-safety.ts instead.
// ---------------------------------------------------------------------------

export interface RefNameProps {
  name: string
  className?: string
}

export function RefName({ name, className }: RefNameProps): React.ReactElement {
  return <ReviewSafeName name={name} className={className} />
}
