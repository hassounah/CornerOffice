import type React from 'react'

// ---------------------------------------------------------------------------
// realm-chrome.ts — the realm skin's wrapper styles for components that were written against the office `--co-*`
// tokens (the Settings Chamber's classic panels, and the workspace manager and dialogs, #0039 UX M2). Wrap the
// component in a div with `{ ...classicSettingsChrome, ...realmTokenOverrides }`: the custom properties inherit through
// the DOM, so they also reach a native <dialog> opened from inside the wrapper (top layer or not).
// ---------------------------------------------------------------------------

const realmTextShadow = '0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.5)'

export const classicSettingsChrome: React.CSSProperties = {
  background: 'rgba(10,6,2,0.7)',
  border: '1px solid rgba(201,168,76,0.3)',
  borderRadius: 6,
  padding: '12px 16px',
  color: '#e8d5a3',
  fontFamily: 'serif',
  textShadow: realmTextShadow,
}

export const realmTokenOverrides: Record<string, string> & React.CSSProperties = {
  // Base tokens (used by inline styles and as var() indirection source)
  // bg-primary is the panel of the dialogs the workspace manager opens (Create, Discover, Remove): gold-dark, not navy.
  '--co-bg-primary': '#1e140a',
  '--color-co-bg-primary': '#1e140a',
  '--co-bg-secondary': 'rgba(20,14,6,0.6)',
  '--co-bg-tertiary': 'rgba(30,20,8,0.7)',
  '--co-bg-elevated': 'rgba(25,18,7,0.8)',
  '--co-text-primary': '#f5edd4',
  '--co-text-secondary': '#c9b88e',
  '--co-text-muted': '#9c8a6a',
  '--co-border': 'rgba(201,168,76,0.25)',
  '--co-border-glow': 'rgba(201,168,76,0.35)',
  '--co-accent': '#c9a84c',
  '--co-accent-dim': '#a8893d',
  '--co-accent-glow': 'rgba(201,168,76,0.15)',
  // Tailwind 4 utilities reference --color-co-* directly; set them so
  // bg-co-accent, text-co-text-primary, etc. resolve to gold theme
  '--color-co-bg-secondary': 'rgba(20,14,6,0.6)',
  '--color-co-bg-tertiary': 'rgba(30,20,8,0.7)',
  '--color-co-bg-elevated': 'rgba(25,18,7,0.8)',
  '--color-co-text-primary': '#f5edd4',
  '--color-co-text-secondary': '#c9b88e',
  '--color-co-text-muted': '#9c8a6a',
  '--color-co-border': 'rgba(201,168,76,0.25)',
  '--color-co-border-glow': 'rgba(201,168,76,0.35)',
  '--color-co-accent': '#c9a84c',
  '--color-co-accent-dim': '#a8893d',
  '--color-co-accent-violet': '#c9a84c',
  '--color-co-accent-violet-dim': '#a8893d',
} as Record<string, string> & React.CSSProperties
