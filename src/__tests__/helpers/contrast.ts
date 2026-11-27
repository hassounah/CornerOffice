import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// WCAG 2.x relative-luminance contrast ratio (the standard formula), plus
// helpers that read the real deployed values out of globals.css so tests can
// never silently drift from what the app ships.
// ---------------------------------------------------------------------------

export function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** sRGB `color-mix(in srgb, fg <weight*100>%, bg)` for two #rrggbb colors, as #rrggbb. */
export function mixHex(fg: string, bg: string, weight: number): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const a = channels(fg)
  const b = channels(bg)
  return '#' + a.map((v, i) => Math.round(v * weight + b[i] * (1 - weight)).toString(16).padStart(2, '0')).join('')
}

export function contrastRatio(hexA: string, hexB: string): number {
  const lA = luminance(hexA)
  const lB = luminance(hexB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

/** First `"<selector> {"` in the css, up to (not including) the first `}`. */
export function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`selector not found in globals.css: ${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

/** Value of `--<name>` in a block, only when it is a plain 6-digit hex. */
export function extractVar(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)
  if (!match) throw new Error(`--${name} not found (or not a plain hex color) in this block`)
  return match[1]
}

const CSS_PATH = path.join(__dirname, '..', '..', 'renderer', 'styles', 'globals.css')

export function readGlobalsCss(): string {
  return fs.readFileSync(CSS_PATH, 'utf-8')
}
