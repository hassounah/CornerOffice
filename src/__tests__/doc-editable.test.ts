import { describe, it, expect } from 'vitest'
import { EDITABLE_EXTENSIONS, isEditable } from '../renderer/utils/doc-editable'
import type { DocFileResponse } from '../main/types/docs'

// ---------------------------------------------------------------------------
// Helper — build a minimal DocFileResponse for a given extension
// ---------------------------------------------------------------------------

function makeFile(extension: string): DocFileResponse {
  return {
    filePath: `/docs/file.${extension}`,
    name: `file.${extension}`,
    extension,
    content: 'hello',
    size: 5,
    lastModified: '2026-01-01T00:00:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// EDITABLE_EXTENSIONS
// ---------------------------------------------------------------------------

describe('EDITABLE_EXTENSIONS', () => {
  it('contains md, yaml, yml, txt', () => {
    expect(EDITABLE_EXTENSIONS.has('md')).toBe(true)
    expect(EDITABLE_EXTENSIONS.has('yaml')).toBe(true)
    expect(EDITABLE_EXTENSIONS.has('yml')).toBe(true)
    expect(EDITABLE_EXTENSIONS.has('txt')).toBe(true)
  })

  it('does not contain non-text extensions', () => {
    for (const ext of ['png', 'jpg', 'pdf', 'js', 'ts', 'json', '']) {
      expect(EDITABLE_EXTENSIONS.has(ext), `Expected ${ext} to not be editable`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// isEditable
// ---------------------------------------------------------------------------

describe('isEditable', () => {
  it('returns true for .md', () => {
    expect(isEditable(makeFile('md'))).toBe(true)
  })

  it('returns true for .yaml', () => {
    expect(isEditable(makeFile('yaml'))).toBe(true)
  })

  it('returns true for .yml', () => {
    expect(isEditable(makeFile('yml'))).toBe(true)
  })

  it('returns true for .txt', () => {
    expect(isEditable(makeFile('txt'))).toBe(true)
  })

  it('returns false for .png', () => {
    expect(isEditable(makeFile('png'))).toBe(false)
  })

  it('returns false for .js', () => {
    expect(isEditable(makeFile('js'))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isEditable(null)).toBe(false)
  })

  it('returns false for a file with empty extension', () => {
    expect(isEditable(makeFile(''))).toBe(false)
  })
})
