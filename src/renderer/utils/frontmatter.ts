import { load, JSON_SCHEMA, YAMLException } from 'js-yaml'

// ---------------------------------------------------------------------------
// Minimal YAML front matter parser (replaces gray-matter, whose js-yaml 3 →
// argparse → sprintf-js chain carried an unpatched advisory). Only a plain
// `---` fence is recognised: language fences such as `---js` never match, so
// no front matter engine can ever execute (Sec M-4) — such input is simply
// rendered as markdown. JSON_SCHEMA keeps dates and other YAML-only types as
// plain strings.
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  content: string
}

const FENCED = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/

/** js-yaml 5 throws on input with no document (empty, whitespace or comment-only). */
function isEmptyYamlError(e: unknown): boolean {
  return e instanceof YAMLException && e.reason === 'expected a document, but the input is empty'
}

/**
 * Splits a leading `---` front matter block from the body. Throws on malformed
 * YAML (callers fall back to rendering the raw input). Non-object front matter
 * (a scalar or a list) yields empty data.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = FENCED.exec(raw)
  if (!match) return { data: {}, content: raw }
  let loaded: unknown
  try {
    loaded = load(match[1] ?? '', { schema: JSON_SCHEMA })
  } catch (e) {
    if (!isEmptyYamlError(e)) throw e
    loaded = null
  }
  const data = loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)
    ? (loaded as Record<string, unknown>)
    : {}
  return { data, content: match[2] }
}
