import { LanguageDescription } from '@codemirror/language'
import type { LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

// ---------------------------------------------------------------------------
// cm/languages.ts — lazy language loading for SourceView (TRD §3.6.5)
//
// Each language is its own chunk (@codemirror/lang-*); this module decides
// WHICH one a filename needs and loads it once, sharing the result across
// every file of the same language for the life of the renderer process.
// Unknown filenames, and files the caller has already classified with
// `highlight: false`, simply get no language support (plain text) — the
// caller (SourceView.tsx, 2.16) is responsible for not calling this at all
// in the latter case.
// ---------------------------------------------------------------------------

const loadedByLanguageName = new Map<string, Promise<LanguageSupport>>()

/**
 * Resolve and lazily load the CodeMirror language for `filename`, caching
 * the load in a module-level Map keyed by the matched language's name so a
 * second file of the same language reuses the same in-flight or completed
 * load instead of importing its chunk again. Returns null when no language
 * matches the filename.
 */
export function loadLanguageForFile(filename: string): Promise<LanguageSupport | null> {
  const desc = LanguageDescription.matchFilename(languages, filename)
  if (!desc) return Promise.resolve(null)

  const cached = loadedByLanguageName.get(desc.name)
  if (cached) return cached

  const promise = desc.load()
  loadedByLanguageName.set(desc.name, promise)
  return promise
}
