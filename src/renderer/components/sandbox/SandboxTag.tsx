import React from 'react'

// ---------------------------------------------------------------------------
// SandboxTag — the small persistent "Sandbox" chip every sandbox-originated
// surface carries (TRD §3.15.2, §3.17, M3). Channel content from a sandbox is
// agent-controlled and could imitate a host session, so provenance is shown
// on every item, not only on error states. Skin-agnostic logic with a `skin`
// prop for chrome only; the text and label are identical in both skins.
// ---------------------------------------------------------------------------

export interface SandboxTagProps {
  /** The workspace whose sandbox this came from (plain text, only used in the visually-hidden label). Empty for a notice that belongs to no workspace (image ready). */
  workspace: string
  skin?: 'office' | 'realm'
}

const REALM_STYLE: React.CSSProperties = {
  background: 'rgba(30,20,10,0.6)',
  border: '1px solid rgba(201,168,76,0.4)',
  color: '#c9a84c',
  fontFamily: 'serif',
}

export function SandboxTag({ workspace, skin = 'office' }: SandboxTagProps): React.ReactElement {
  const isRealm = skin === 'realm'
  return (
    <span
      className={
        isRealm
          ? 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium'
          : 'inline-flex items-center rounded-full border border-co-border bg-co-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-co-text-secondary'
      }
      style={isRealm ? REALM_STYLE : undefined}
    >
      Sandbox
      <span className="sr-only"> {workspace ? `(from the sandbox for ${workspace})` : '(from the sandbox)'}</span>
    </span>
  )
}
