import { describe, it, expect } from 'vitest'
import { formatToolPreview } from '../renderer/utils/format-tool-preview'

describe('formatToolPreview', () => {
  it('Bash: extracts command', () => {
    expect(formatToolPreview('Bash', '{"command":"git status","description":"Check git status"}')).toBe('git status')
  })

  it('Read: extracts file_path', () => {
    expect(formatToolPreview('Read', '{"file_path":"/home/amer/file.ts"}')).toBe('/home/amer/file.ts')
  })

  it('Write: extracts file_path', () => {
    expect(formatToolPreview('Write', '{"file_path":"/home/amer/file.ts","content":"hello"}')).toBe('/home/amer/file.ts')
  })

  it('Edit: extracts file_path', () => {
    expect(formatToolPreview('Edit', '{"file_path":"/home/amer/file.ts","old_string":"a","new_string":"b"}')).toBe('/home/amer/file.ts')
  })

  it('Grep: pattern only', () => {
    expect(formatToolPreview('Grep', '{"pattern":"log.*Error"}')).toBe('"log.*Error"')
  })

  it('Grep: pattern + path', () => {
    expect(formatToolPreview('Grep', '{"pattern":"log.*Error","path":"src/"}')).toBe('"log.*Error" in src/')
  })

  it('Glob: pattern only', () => {
    expect(formatToolPreview('Glob', '{"pattern":"**/*.ts"}')).toBe('"**/*.ts"')
  })

  it('Glob: pattern + path', () => {
    expect(formatToolPreview('Glob', '{"pattern":"**/*.ts","path":"src/"}')).toBe('"**/*.ts" in src/')
  })

  it('case-insensitive tool name (lowercase)', () => {
    expect(formatToolPreview('bash', '{"command":"ls"}')).toBe('ls')
  })

  it('case-insensitive tool name (uppercase)', () => {
    expect(formatToolPreview('BASH', '{"command":"ls"}')).toBe('ls')
  })

  it('unknown tool: raw fallback', () => {
    const raw = '{"foo":"bar"}'
    expect(formatToolPreview('CustomTool', raw)).toBe(raw)
  })

  it('invalid JSON: raw fallback', () => {
    expect(formatToolPreview('Bash', 'not json')).toBe('not json')
  })

  it('missing key field: raw fallback', () => {
    const raw = '{"description":"no command"}'
    expect(formatToolPreview('Bash', raw)).toBe(raw)
  })

  it('empty command: raw fallback', () => {
    const raw = '{"command":""}'
    expect(formatToolPreview('Bash', raw)).toBe(raw)
  })

  it('empty file_path: raw fallback', () => {
    const raw = '{"file_path":""}'
    expect(formatToolPreview('Read', raw)).toBe(raw)
  })

  it('empty pattern: raw fallback', () => {
    const raw = '{"pattern":""}'
    expect(formatToolPreview('Grep', raw)).toBe(raw)
  })
})
