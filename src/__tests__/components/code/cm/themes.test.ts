import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { officeTheme, realmTheme } from '../../../../renderer/components/code/cm/themes'

// ---------------------------------------------------------------------------
// WCAG 2.x relative-luminance contrast ratio (the standard formula; verified
// below against the black-on-white reference of exactly 21:1).
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = luminance(hexA)
  const lB = luminance(hexB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

const WCAG_AA = 4.5

describe('contrastRatio', () => {
  it('matches the known black-on-white reference of 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })

  it('is 1:1 for identical colors', () => {
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5)
  })
})

// ---------------------------------------------------------------------------
// officeTheme — reads the actual deployed values from globals.css, so this
// can never silently drift from what the app really ships.
// ---------------------------------------------------------------------------

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

function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`selector not found in globals.css: ${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

function extractVar(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)
  if (!match) throw new Error(`--${name} not found (or not a plain hex color) in this block`)
  return match[1]
}

const CSS_PATH = path.join(__dirname, '..', '..', '..', '..', 'renderer', 'styles', 'globals.css')

function readGlobalsCss(): string {
  return fs.readFileSync(CSS_PATH, 'utf-8')
}

function readThemeVars(
  tokenVars: readonly string[],
  bgVar: string,
): { dark: Record<string, string>; light: Record<string, string>; darkBg: string; lightBg: string } {
  const css = readGlobalsCss()
  const rootBlock = extractBlock(css, ':root')
  const lightBlock = extractBlock(css, '.theme-light')

  const dark: Record<string, string> = {}
  const light: Record<string, string> = {}
  for (const name of tokenVars) {
    dark[name] = extractVar(rootBlock, name)
    light[name] = extractVar(lightBlock, name)
  }
  return {
    dark,
    light,
    darkBg: extractVar(rootBlock, bgVar),
    lightBg: extractVar(lightBlock, bgVar),
  }
}

describe('officeTheme — WCAG AA 4.5:1 for every token', () => {
  const { dark, light, darkBg, lightBg } = readThemeVars(CODE_TOKEN_VARS, 'co-code-bg')

  it.each(CODE_TOKEN_VARS)('%s reaches 4.5:1 against the dark background', (name) => {
    expect(contrastRatio(darkBg, dark[name])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it.each(CODE_TOKEN_VARS)('%s reaches 4.5:1 against the light background', (name) => {
    expect(contrastRatio(lightBg, light[name])).toBeGreaterThanOrEqual(WCAG_AA)
  })
})

// ---------------------------------------------------------------------------
// realmTheme — #0028 user decision (2026-09-28): Realm's code explorer now
// toggles between a dark palette (:root, the original fixed warm-dark
// values, TRD §3.6.5) and a light "parchment" palette (.theme-light), read
// from globals.css exactly like officeTheme above — so this can never
// silently drift from what the app really ships, in either theme.
// ---------------------------------------------------------------------------

const REALM_TOKEN_VARS = [
  'co-realm-fg',
  'co-realm-gutter-fg',
  'co-realm-comment',
  'co-realm-keyword',
  'co-realm-string',
  'co-realm-number',
  'co-realm-type',
  'co-realm-function',
] as const

describe('realmTheme — WCAG AA 4.5:1 for every token, both palettes', () => {
  const { dark, light, darkBg, lightBg } = readThemeVars(REALM_TOKEN_VARS, 'co-realm-bg')

  it.each(REALM_TOKEN_VARS)('%s reaches 4.5:1 against the dark background', (name) => {
    expect(contrastRatio(darkBg, dark[name])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it.each(REALM_TOKEN_VARS)('%s reaches 4.5:1 against the light (parchment) background', (name) => {
    expect(contrastRatio(lightBg, light[name])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it('the dark background is the exact TRD-specified #17110a', () => {
    expect(darkBg).toBe('#17110a')
  })
})

// ---------------------------------------------------------------------------
// Toggle test — proves the ACTUAL globals.css rules re-theme the realm
// variables when `.theme-light` is toggled on `documentElement`, with no JS
// theme detection: injects the real, verbatim `:root { … }` and
// `.theme-light { … }` blocks (not a hand-typed copy) into a <style> tag and
// reads them back via getComputedStyle, the same mechanism the app itself
// relies on when the appearance setting changes.
// ---------------------------------------------------------------------------

describe('realmTheme — .theme-light toggling re-resolves --co-realm-* (no JS remount)', () => {
  afterEach(() => {
    document.documentElement.classList.remove('theme-light')
    document.getElementById('realm-theme-toggle-probe')?.remove()
  })

  it('resolves the dark values by default and the light values once .theme-light is added', () => {
    const css = readGlobalsCss()
    const rootBlock = `${extractBlock(css, ':root')}}`
    const lightBlock = `${extractBlock(css, '.theme-light')}}`

    const style = document.createElement('style')
    style.id = 'realm-theme-toggle-probe'
    style.textContent = `${rootBlock}\n${lightBlock}`
    document.head.appendChild(style)

    const resolved = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()

    for (const name of ['co-realm-bg', ...REALM_TOKEN_VARS]) {
      expect(resolved(name)).toBe(extractVar(rootBlock, name))
    }

    document.documentElement.classList.add('theme-light')

    for (const name of ['co-realm-bg', ...REALM_TOKEN_VARS]) {
      expect(resolved(name)).toBe(extractVar(lightBlock, name))
      // The two palettes are never accidentally identical for any token —
      // otherwise this test could pass even if the light override silently
      // failed to apply.
      expect(resolved(name)).not.toBe(extractVar(rootBlock, name))
    }
  })
})

// ---------------------------------------------------------------------------
// Fix #148 — officeTheme/realmTheme are functions of CodeMirror's OWN
// internal light/dark classification now, not a hardcoded `dark: true`. This
// is a DIFFERENT axis from the `--co-*` CSS variables above: it's the
// `EditorView.darkTheme` facet several extensions (notably @codemirror/
// merge's own `&light`/`&dark` diff-decoration rules) key off directly, and
// it needs an actual boolean argument rather than resolving through CSS —
// checked here against CodeMirror's own public facet API, not a DOM probe.
// ---------------------------------------------------------------------------

describe('officeTheme/realmTheme — the dark option actually varies (Fix #148)', () => {
  it.each([
    ['officeTheme', officeTheme],
    ['realmTheme', realmTheme],
  ] as const)('%s(true) marks the editor dark; %s(false) marks it light', (_name, theme) => {
    const darkState = EditorState.create({ extensions: theme(true) })
    const lightState = EditorState.create({ extensions: theme(false) })
    expect(darkState.facet(EditorView.darkTheme)).toBe(true)
    expect(lightState.facet(EditorView.darkTheme)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Invisible/bidi character marker (.co-invisible-token/.cm-co-invisible,
// globals.css, TRD §3.6.6 joint High — the Trojan-Source defense) — Fix
// #149. It used to read --co-status-attention/--co-bg-primary: the SAME
// --co-bg-primary that flips per theme for the app's own background, which
// made this marker's text ~2.56:1 in light mode (near-white on a warm-red
// background) — well under AA, for a marker whose whole job is to be
// conspicuous. It now has its own dedicated --co-invisible-marker-bg/-fg
// pair, deliberately fixed and identical in both themes (this marker isn't
// supposed to blend in with either skin), checked here in both blocks
// exactly like officeTheme/realmTheme above so it can't silently drift.
// ---------------------------------------------------------------------------

describe('invisible/bidi character marker — WCAG AA 4.5:1 in both themes (Fix #149)', () => {
  const { dark, light, darkBg, lightBg } = readThemeVars(['co-invisible-marker-fg'] as const, 'co-invisible-marker-bg')

  it('reaches 4.5:1 against its background in dark mode (:root)', () => {
    expect(contrastRatio(darkBg, dark['co-invisible-marker-fg'])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it('reaches 4.5:1 against its background in light mode (.theme-light)', () => {
    expect(contrastRatio(lightBg, light['co-invisible-marker-fg'])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it('is the same fixed pair in both themes — this marker never blends in with either skin', () => {
    expect(light['co-invisible-marker-fg']).toBe(dark['co-invisible-marker-fg'])
    expect(lightBg).toBe(darkBg)
  })
})

// ---------------------------------------------------------------------------
// Fix #151: the chip has no border of its own — its ONLY boundary against
// the surrounding editor canvas was the fill color, which drops to
// ~2.3-2.56:1 against the two LIGHT canvases (below WCAG 1.4.11's 3:1 floor
// for a UI component's boundary, and a real concern for red-green
// colorblind viewers). `--co-invisible-marker-border` is checked here
// against all FOUR possible editor canvases at once (office dark/light,
// realm dark/light) — deliberately NOT reusing --co-invisible-marker-fg
// itself, which happens to equal --co-code-bg's own dark value exactly and
// would be invisible in office dark mode.
// ---------------------------------------------------------------------------

const WCAG_UI_COMPONENT = 3

describe('invisible/bidi character marker — border reaches 3:1 against all four editor canvases (Fix #151)', () => {
  const { dark: markerDark, light: markerLight } = readThemeVars(
    ['co-invisible-marker-border'] as const,
    'co-invisible-marker-bg',
  )
  const officeBgs = readThemeVars([] as const, 'co-code-bg')
  const realmBgs = readThemeVars([] as const, 'co-realm-bg')

  it('the border color is the same fixed value in both themes', () => {
    expect(markerLight['co-invisible-marker-border']).toBe(markerDark['co-invisible-marker-border'])
  })

  it.each([
    ['office dark', officeBgs.darkBg],
    ['office light', officeBgs.lightBg],
    ['realm dark', realmBgs.darkBg],
    ['realm light (parchment)', realmBgs.lightBg],
  ] as const)('reaches 3:1 against the %s canvas', (_label, canvasBg) => {
    expect(contrastRatio(canvasBg, markerDark['co-invisible-marker-border'])).toBeGreaterThanOrEqual(WCAG_UI_COMPONENT)
  })

  it('is NOT --co-invisible-marker-fg — that value happens to equal --co-code-bg\'s own dark value and would be invisible there', () => {
    expect(markerDark['co-invisible-marker-border']).not.toBe(officeBgs.darkBg)
  })
})
