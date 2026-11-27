import { describe, it, expect } from 'vitest'
import { OFFICE_PALETTE_IDS, type OfficePaletteId } from '../../main/types/appearance'
import { contrastRatio, extractBlock, extractVar, mixHex, readGlobalsCss } from '../helpers/contrast'

// ---------------------------------------------------------------------------
// #0040 office color palettes — reads the real globals.css, so the palettes
// can never silently drift from what the app ships. Eucalyptus is the bare
// :root; signal and moss are :root[data-palette='…'] override blocks.
// ---------------------------------------------------------------------------

const WCAG_AA = 4.5
const WCAG_UI_COMPONENT = 3

const PALETTE_BLOCK: Record<OfficePaletteId, string> = {
  eucalyptus: ':root',
  signal: ":root[data-palette='signal']",
  moss: ":root[data-palette='moss']",
}

const HEX_TOKENS = [
  'co-bg-primary',
  'co-bg-secondary',
  'co-bg-tertiary',
  'co-bg-elevated',
  'co-border',
  'co-border-glow',
  'co-text-primary',
  'co-text-secondary',
  'co-text-muted',
  'co-accent',
  'co-accent-dim',
  'co-on-accent',
  'co-accent-teal',
  'co-status-active',
  'co-status-waiting',
  'co-status-parked',
  'co-status-idle',
  'co-status-attention',
  'co-ship-gold',
  'co-code-bg',
  'co-code-gutter-bg',
] as const

const CODE_TOKEN_VARS = [
  'co-code-fg',
  'co-code-gutter-fg',
  'co-code-comment',
  'co-code-keyword',
  'co-code-string',
  'co-code-number',
  'co-code-type',
  'co-code-function',
  'co-code-variable',
] as const

const TEXT_TOKENS = [
  'co-text-primary',
  'co-text-secondary',
  'co-text-muted',
  'co-accent',
  'co-accent-teal',
  'co-ship-gold',
] as const

const STATUS_TOKENS = [
  'co-status-active',
  'co-status-waiting',
  'co-status-parked',
  'co-status-idle',
  'co-status-attention',
] as const

// TRD section 3 table, including the AA-adjusted muted and idle values.
const EXPECTED_PALETTES: Record<OfficePaletteId, Record<(typeof HEX_TOKENS)[number], string>> = {
  eucalyptus: {
    'co-bg-primary': '#0e1416',
    'co-bg-secondary': '#141c1f',
    'co-bg-tertiary': '#1c2629',
    'co-bg-elevated': '#1f2a2d',
    'co-border': '#1f2a2d',
    'co-border-glow': '#2c3a3e',
    'co-text-primary': '#e3ebe8',
    'co-text-secondary': '#9fb0ab',
    'co-text-muted': '#788a83',
    'co-accent': '#5fb49c',
    'co-accent-dim': '#488776',
    'co-on-accent': '#06140f',
    'co-accent-teal': '#d6b98c',
    'co-status-active': '#93c86f',
    'co-status-waiting': '#e0b354',
    'co-status-parked': '#8fa2c6',
    'co-status-idle': '#5a6b66',
    'co-status-attention': '#e27c6b',
    'co-ship-gold': '#e0b354',
    'co-code-bg': '#0a1012',
    'co-code-gutter-bg': '#0a1012',
  },
  signal: {
    'co-bg-primary': '#111315',
    'co-bg-secondary': '#181b1e',
    'co-bg-tertiary': '#212529',
    'co-bg-elevated': '#24282d',
    'co-border': '#24282d',
    'co-border-glow': '#343a41',
    'co-text-primary': '#e6e8ea',
    'co-text-secondary': '#a3a9b0',
    'co-text-muted': '#7e858d',
    'co-accent': '#f07a3a',
    'co-accent-dim': '#b25d30',
    'co-on-accent': '#1a0d05',
    'co-accent-teal': '#78aed0',
    'co-status-active': '#62c290',
    'co-status-waiting': '#e8c14e',
    'co-status-parked': '#9aa3ad',
    'co-status-idle': '#606872',
    'co-status-attention': '#ec5a52',
    'co-ship-gold': '#e8c14e',
    'co-code-bg': '#0c0e10',
    'co-code-gutter-bg': '#0c0e10',
  },
  moss: {
    'co-bg-primary': '#121410',
    'co-bg-secondary': '#191c16',
    'co-bg-tertiary': '#22261e',
    'co-bg-elevated': '#252a21',
    'co-border': '#252a21',
    'co-border-glow': '#353b2f',
    'co-text-primary': '#e8e9e1',
    'co-text-secondary': '#abae9f',
    'co-text-muted': '#83876f',
    'co-accent': '#a3b86c',
    'co-accent-dim': '#7a8a52',
    'co-on-accent': '#141a08',
    'co-accent-teal': '#8aa6c1',
    'co-status-active': '#6cc0a8',
    'co-status-waiting': '#e0b04f',
    'co-status-parked': '#a19fb3',
    'co-status-idle': '#656a5a',
    'co-status-attention': '#e06a5a',
    'co-ship-gold': '#e0b04f',
    'co-code-bg': '#0e100c',
    'co-code-gutter-bg': '#0e100c',
  },
}

// Pre-#0040 office values that .co-realm-scope must keep frozen.
const REALM_FROZEN: Record<string, string> = {
  'co-bg-primary': '#0a0c14',
  'co-bg-secondary': '#111420',
  'co-bg-tertiary': '#1a1e2e',
  'co-bg-elevated': '#1e2235',
  'co-text-primary': '#e8eaf4',
  'co-text-secondary': '#a0a4b8',
  'co-text-muted': '#636882',
  'co-border': '#1e2235',
  'co-border-glow': '#2a3050',
  'co-accent': '#7c6aff',
  'co-accent-dim': '#5a4ad4',
  'co-on-accent': '#ffffff',
  'co-accent-teal': '#22d3c5',
  'co-status-active': '#34d399',
  'co-status-waiting': '#fbbf24',
  'co-status-parked': '#a78bfa',
  'co-status-idle': '#4b5068',
  'co-status-attention': '#f87171',
  'co-ship-gold': '#f59e0b',
}

const REALM_FROZEN_RGBA: Record<string, string> = {
  'co-accent-glow': 'rgba(124, 106, 255, 0.15)',
  'co-accent-teal-glow': 'rgba(34, 211, 197, 0.12)',
  'co-glass-bg': 'rgba(17, 20, 32, 0.6)',
  'co-sidebar-bg': 'rgba(10, 12, 20, 0.85)',
}

const css = readGlobalsCss()

/** The text of the rule starting at `selector {`, matched by brace depth (not the first `}`). */
function ruleSpan(source: string, selector: string): [number, number] {
  const start = source.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`selector not found: ${selector}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return [start, i + 1]
  }
  throw new Error(`unbalanced braces for: ${selector}`)
}

function stripRule(source: string, selector: string): string {
  const [start, end] = ruleSpan(source, selector)
  return source.slice(0, start) + source.slice(end)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function paletteVars(id: OfficePaletteId): Record<(typeof HEX_TOKENS)[number], string> {
  const block = extractBlock(css, PALETTE_BLOCK[id])
  return Object.fromEntries(HEX_TOKENS.map((name) => [name, extractVar(block, name)])) as Record<
    (typeof HEX_TOKENS)[number],
    string
  >
}

describe('office palettes — completeness', () => {
  it('knows the three palette ids', () => {
    expect([...OFFICE_PALETTE_IDS]).toEqual(['eucalyptus', 'signal', 'moss'])
  })

  it.each(OFFICE_PALETTE_IDS)('%s has a block that defines every hex token as a plain hex', (id) => {
    expect(css).toContain(`${PALETTE_BLOCK[id]} {`)
    const block = extractBlock(css, PALETTE_BLOCK[id])
    for (const name of HEX_TOKENS) {
      expect(() => extractVar(block, name), `--${name} in ${id}`).not.toThrow()
    }
  })

  it('the three palettes are distinct from each other', () => {
    const accents = OFFICE_PALETTE_IDS.map((id) => paletteVars(id)['co-accent'])
    expect(new Set(accents).size).toBe(OFFICE_PALETTE_IDS.length)
  })

  it.each(OFFICE_PALETTE_IDS)('%s matches the exact TRD section 3 values', (id) => {
    expect(paletteVars(id)).toEqual(EXPECTED_PALETTES[id])
  })

  it.each(OFFICE_PALETTE_IDS)('%s keeps --co-bg-elevated equal to --co-border', (id) => {
    const vars = paletteVars(id)
    expect(vars['co-bg-elevated']).toBe(vars['co-border'])
  })

  it('the derived tokens are defined once on :root, not hardcoded per palette', () => {
    const root = extractBlock(css, ':root')
    expect(root).toMatch(/--co-accent-glow:\s*color-mix\(/)
    expect(root).toMatch(/--co-accent-teal-glow:\s*color-mix\(/)
    expect(root).toMatch(/--co-glass-bg:\s*color-mix\(/)
    expect(root).toMatch(/--co-sidebar-bg:\s*color-mix\(/)
    expect(root).toMatch(/--co-code-caret:\s*var\(--co-accent\)/)
    expect(root).toMatch(/--co-code-selection:\s*color-mix\(/)
    for (const id of ['signal', 'moss'] as const) {
      expect(extractBlock(css, PALETTE_BLOCK[id])).not.toMatch(
        /--co-(accent-glow|accent-teal-glow|glass-bg|sidebar-bg|code-caret|code-selection)/,
      )
    }
  })
})

describe.each(OFFICE_PALETTE_IDS)('office palette %s — WCAG contrast', (id) => {
  const vars = paletteVars(id)
  const surfaces = ['co-bg-primary', 'co-bg-secondary'] as const

  it.each(TEXT_TOKENS.flatMap((t) => surfaces.map((s) => [t, s] as const)))(
    '%s reaches 4.5:1 on %s',
    (token, surface) => {
      expect(contrastRatio(vars[surface], vars[token])).toBeGreaterThanOrEqual(WCAG_AA)
    },
  )

  it.each(STATUS_TOKENS.flatMap((t) => surfaces.map((s) => [t, s] as const)))(
    '%s reaches 3:1 on %s',
    (token, surface) => {
      expect(contrastRatio(vars[surface], vars[token])).toBeGreaterThanOrEqual(WCAG_UI_COMPONENT)
    },
  )

  // Pills styled `bg-co-accent/20 text-co-accent` (TeamLevelBadge, InstinctCard, ...) put accent
  // text on accent mixed 20% over the card surface.
  it('accent text reaches 4.5:1 on the accent/20 pill tint over bg-secondary', () => {
    const tint = mixHex(vars['co-accent'], vars['co-bg-secondary'], 0.2)
    expect(contrastRatio(tint, vars['co-accent'])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it('on-accent reaches 4.5:1 on accent', () => {
    expect(contrastRatio(vars['co-accent'], vars['co-on-accent'])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it('code-bg and code-gutter-bg are the same recessed canvas', () => {
    expect(vars['co-code-gutter-bg']).toBe(vars['co-code-bg'])
  })

  it.each(CODE_TOKEN_VARS)('%s (unchanged syntax token) reaches 4.5:1 on this palette\'s code-bg', (name) => {
    const rootValue = extractVar(extractBlock(css, ':root'), name)
    expect(contrastRatio(vars['co-code-bg'], rootValue)).toBeGreaterThanOrEqual(WCAG_AA)
  })
})

describe('old violet/teal/emerald literals are gone from office tokens', () => {
  // Strip the two blocks that legitimately keep the old values.
  const stripped = ['.co-realm-scope', '.theme-light'].reduce((acc, selector) => stripRule(acc, selector), css)

  it.each(['#7c6aff', '#22d3c5', '124, 106, 255', '34, 211, 197', '52, 211, 153'])(
    'has no %s outside .co-realm-scope and .theme-light',
    (literal) => {
      expect(stripped.toLowerCase()).not.toContain(literal)
    },
  )

  it('actually stripped the blocks (the literals are still present in the full file)', () => {
    expect(css.toLowerCase()).toContain('#7c6aff')
    expect(stripped.length).toBeLessThan(css.length)
  })
})

describe('.co-realm-scope — realm keeps its pre-#0040 colors', () => {
  const scope = extractBlock(css, '.co-realm-scope')

  it('freezes every pre-#0040 hex value', () => {
    for (const [name, value] of Object.entries(REALM_FROZEN)) {
      expect(extractVar(scope, name), `--${name}`).toBe(value)
    }
  })

  it('freezes the literal glow, glass and sidebar rgba values', () => {
    for (const [name, value] of Object.entries(REALM_FROZEN_RGBA)) {
      expect(scope, `--${name}`).toMatch(new RegExp(`--${name}:\\s*${escapeRegExp(value)};`))
    }
  })

  it('covers every hex token the palettes drive (except code tokens)', () => {
    const palettes = HEX_TOKENS.filter((n) => !n.startsWith('co-code-'))
    expect(Object.keys(REALM_FROZEN).sort()).toEqual([...palettes].sort())
  })

  it('re-declares every --color-co-* mapping from @theme so Tailwind utilities follow the scope', () => {
    const theme = extractBlock(css, '@theme')
    const mappings = [...theme.matchAll(/--color-co-[a-z-]+:\s*var\(--co-[a-z-]+\);/g)].map((m) => m[0])
    expect(mappings.length).toBeGreaterThan(0)
    for (const mapping of mappings) {
      expect(scope, mapping).toMatch(new RegExp(`^\\s*${escapeRegExp(mapping)}\\s*$`, 'm'))
    }
    expect(scope).toMatch(/^\s*--color-co-accent: var\(--co-accent\);\s*$/m)
  })
})
