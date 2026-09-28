import { describe, it, expect, afterEach, vi } from 'vitest'
import { LanguageDescription } from '@codemirror/language'
import { loadLanguageForFile } from '../../../../renderer/components/code/cm/languages'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadLanguageForFile', () => {
  it('resolves to null for a filename with no matching language', () => {
    return expect(loadLanguageForFile('README.unknownext')).resolves.toBeNull()
  })

  it('loads TypeScript support for a .ts file', async () => {
    const support = await loadLanguageForFile('index.ts')
    expect(support).not.toBeNull()
    expect(support?.language.name).toBe('typescript')
  })

  it('loads the matching language for a few common extensions', async () => {
    const py = await loadLanguageForFile('script.py')
    const css = await loadLanguageForFile('styles.css')
    const json = await loadLanguageForFile('data.json')
    expect(py?.language.name).toBe('python')
    expect(css?.language.name).toBe('css')
    expect(json?.language.name).toBe('json')
  })

  it('caches the load across two files of the same language (one chunk import)', async () => {
    // A language untouched by the other tests in this file, so the module's
    // cache Map starts genuinely empty for it.
    const loadSpy = vi.spyOn(LanguageDescription.prototype, 'load')
    await loadLanguageForFile('a.rs')
    await loadLanguageForFile('b.rs')
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })
})
