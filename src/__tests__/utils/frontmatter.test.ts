import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '../../renderer/utils/frontmatter'

describe('parseFrontmatter', () => {
  it('returns the input unchanged when there is no front matter', () => {
    expect(parseFrontmatter('# Title\nbody')).toEqual({ data: {}, content: '# Title\nbody' })
  })

  it('splits YAML front matter from the body', () => {
    expect(parseFrontmatter('---\ntitle: Hello\ntags: [a, b]\n---\nbody')).toEqual({
      data: { title: 'Hello', tags: ['a', 'b'] },
      content: 'body',
    })
  })

  it('handles CRLF line endings', () => {
    expect(parseFrontmatter('---\r\ntitle: Hi\r\n---\r\nbody')).toEqual({ data: { title: 'Hi' }, content: 'body' })
  })

  it('treats an empty front matter block as empty data', () => {
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ data: {}, content: 'body' })
  })

  it('treats a comment-only front matter block as empty data', () => {
    expect(parseFrontmatter('---\n# just a note\n---\nbody')).toEqual({ data: {}, content: 'body' })
  })

  it('accepts front matter with no body', () => {
    expect(parseFrontmatter('---\ntitle: Only\n---')).toEqual({ data: { title: 'Only' }, content: '' })
  })

  it('keeps dates as strings (JSON schema)', () => {
    expect(parseFrontmatter('---\ncreated: 2026-01-02\n---\n').data).toEqual({ created: '2026-01-02' })
  })

  it('yields empty data for non-object front matter', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\nbody')).toEqual({ data: {}, content: 'body' })
    expect(parseFrontmatter('---\njust text\n---\nbody')).toEqual({ data: {}, content: 'body' })
  })

  it('never matches a language fence such as ---js (no engine execution)', () => {
    const raw = '---js\n(globalThis.__pwn = 1)\n---\nbody'
    expect(parseFrontmatter(raw)).toEqual({ data: {}, content: raw })
  })

  it('throws on malformed YAML so callers can fall back', () => {
    expect(() => parseFrontmatter('---\nfoo: "unterminated\n---\nbody')).toThrow()
  })
})
