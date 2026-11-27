import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { officeTheme, realmTheme } from '../../../../renderer/components/code/cm/themes'
import { contrastRatio, extractBlock, extractVar, readGlobalsCss } from '../../../helpers/contrast'

// The WCAG contrast helpers live in helpers/contrast.ts; the black-on-white
// reference of exactly 21:1 below verifies the formula.

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
// officeTheme — reads the actual deployed :root values from globals.css, so
// this can never silently drift from what the app really ships. The other
// palettes' overrides are checked in office-palettes.test.ts.
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

function readRootVars(tokenVars: readonly string[], bgVar: string): { vars: Record<string, string>; bg: string } {
  const rootBlock = extractBlock(readGlobalsCss(), ':root')
  const vars: Record<string, string> = {}
  for (const name of tokenVars) {
    vars[name] = extractVar(rootBlock, name)
  }
  return { vars, bg: extractVar(rootBlock, bgVar) }
}

describe('officeTheme — WCAG AA 4.5:1 for every token', () => {
  const { vars, bg } = readRootVars(CODE_TOKEN_VARS, 'co-code-bg')

  it.each(CODE_TOKEN_VARS)('%s reaches 4.5:1 against the background', (name) => {
    expect(contrastRatio(bg, vars[name])).toBeGreaterThanOrEqual(WCAG_AA)
  })
})

// ---------------------------------------------------------------------------
// realmTheme — the fixed warm-dark palette (TRD §3.6.5), read from
// globals.css exactly like officeTheme above.
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

describe('realmTheme — WCAG AA 4.5:1 for every token', () => {
  const { vars, bg } = readRootVars(REALM_TOKEN_VARS, 'co-realm-bg')

  it.each(REALM_TOKEN_VARS)('%s reaches 4.5:1 against the background', (name) => {
    expect(contrastRatio(bg, vars[name])).toBeGreaterThanOrEqual(WCAG_AA)
  })

  it('the background is the exact TRD-specified #17110a', () => {
    expect(bg).toBe('#17110a')
  })
})

// ---------------------------------------------------------------------------
// CodeMirror's own light/dark classification (the `EditorView.darkTheme`
// facet, which @codemirror/merge's `&dark` diff-decoration rules key off).
// The app is dark-only, so both themes must mark the editor dark.
// ---------------------------------------------------------------------------

describe('officeTheme/realmTheme — mark the editor dark', () => {
  it.each([
    ['officeTheme', officeTheme],
    ['realmTheme', realmTheme],
  ] as const)('%s sets EditorView.darkTheme', (_name, theme) => {
    const state = EditorState.create({ extensions: theme })
    expect(state.facet(EditorView.darkTheme)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Invisible/bidi character marker (.co-invisible-token/.cm-co-invisible,
// globals.css, TRD §3.6.6 joint High — the Trojan-Source defense) — Fix
// #149. It has its own dedicated --co-invisible-marker-bg/-fg pair, fixed
// regardless of skin or palette, checked here so it can't silently drift.
// ---------------------------------------------------------------------------

describe('invisible/bidi character marker — WCAG AA 4.5:1 (Fix #149)', () => {
  const { vars, bg } = readRootVars(['co-invisible-marker-fg'] as const, 'co-invisible-marker-bg')

  it('reaches 4.5:1 against its background', () => {
    expect(contrastRatio(bg, vars['co-invisible-marker-fg'])).toBeGreaterThanOrEqual(WCAG_AA)
  })
})

// ---------------------------------------------------------------------------
// Fix #151: the chip has no border of its own, so
// `--co-invisible-marker-border` gives it a boundary (WCAG 1.4.11's 3:1 for
// a UI component) against both editor canvases — deliberately NOT reusing
// --co-invisible-marker-fg itself, which is near-identical to the office
// canvas (#0a0c14 vs the palette's #0a1012 recessed bg0).
// ---------------------------------------------------------------------------

const WCAG_UI_COMPONENT = 3

describe('invisible/bidi character marker — border reaches 3:1 against both editor canvases (Fix #151)', () => {
  const { vars: marker } = readRootVars(['co-invisible-marker-border'] as const, 'co-invisible-marker-bg')
  const officeBg = readRootVars([] as const, 'co-code-bg').bg
  const realmBg = readRootVars([] as const, 'co-realm-bg').bg

  it.each([
    ['office', officeBg],
    ['realm', realmBg],
  ] as const)('reaches 3:1 against the %s canvas', (_label, canvasBg) => {
    expect(contrastRatio(canvasBg, marker['co-invisible-marker-border'])).toBeGreaterThanOrEqual(WCAG_UI_COMPONENT)
  })

  it('is NOT --co-invisible-marker-fg — that near-black value would be invisible against the office canvas', () => {
    expect(marker['co-invisible-marker-border']).not.toBe(officeBg)
  })
})
