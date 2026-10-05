import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HomunculusParserService } from '../main/services/homunculus-parser'

vi.mock('fs')
import fs from 'fs'
const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

// gray-matter is NOT mocked — we test real YAML parsing

// ---------------------------------------------------------------------------
// Virtual-file helpers — parseInstincts/parseEvolvedArtifacts go through
// safe-fs.ts's readRegularFileCappedSync, and parseRecentObservations
// through its own lstat -> open(O_NOFOLLOW) -> fstat -> readSync sequence
// (H2). Only the low-level `fs` calls are mocked, so these helpers simulate
// whichever file was most recently `openSync`'d rather than stubbing
// readFileSync directly.
// ---------------------------------------------------------------------------

/** Single named file, e.g. observations.jsonl or a lone instinct file. */
function mockRegularFile(content: string): void {
  const buf = Buffer.from(content, 'utf-8')
  mockFs.lstatSync = vi.fn().mockReturnValue({ isFile: () => true })
  mockFs.openSync = vi.fn().mockReturnValue(3)
  mockFs.fstatSync = vi.fn().mockReturnValue({ isFile: () => true, size: buf.length })
  mockFs.readSync = vi.fn().mockImplementation((_fd: number, out: Buffer, _outOff: number, len: number, pos: number) => {
    const slice = buf.subarray(pos, pos + len)
    slice.copy(out)
    return slice.length
  })
  mockFs.closeSync = vi.fn()
}

/** Several files at distinct paths — fstat/readSync serve whichever path
 *  openSync was most recently called with (matches the real synchronous
 *  open-then-read-then-close-per-file call pattern in the parser). */
function mockFilesByPath(contents: Record<string, string>): void {
  let lastPath = ''
  mockFs.lstatSync = vi.fn().mockImplementation((p: string) => {
    if (!(p in contents)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { isFile: () => true }
  })
  mockFs.openSync = vi.fn().mockImplementation((p: string) => {
    lastPath = p
    return 3
  })
  mockFs.fstatSync = vi.fn().mockImplementation(() => {
    const buf = Buffer.from(contents[lastPath], 'utf-8')
    return { isFile: () => true, size: buf.length }
  })
  mockFs.readSync = vi.fn().mockImplementation((_fd: number, out: Buffer, _outOff: number, len: number, pos: number) => {
    const buf = Buffer.from(contents[lastPath], 'utf-8')
    const slice = buf.subarray(pos, pos + len)
    slice.copy(out)
    return slice.length
  })
  mockFs.closeSync = vi.fn()
}

/** A symlink or FIFO: lstat succeeds but isFile() is false. */
function mockNonRegularFile(): void {
  mockFs.lstatSync = vi.fn().mockReturnValue({ isFile: () => false })
  mockFs.openSync = vi.fn()
}

function mockMissingFile(): void {
  mockFs.lstatSync = vi.fn().mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

describe('HomunculusParserService', () => {
  let parser: HomunculusParserService

  beforeEach(() => {
    vi.clearAllMocks()
    parser = new HomunculusParserService()
    mockFs.existsSync = vi.fn().mockReturnValue(false)
    mockFs.readdirSync = vi.fn().mockReturnValue([])
    mockFs.statSync = vi.fn().mockReturnValue({ mtime: new Date('2026-03-01'), isFile: () => true, size: 0 })
    mockFs.lstatSync = vi.fn()
    mockFs.openSync = vi.fn()
    mockFs.fstatSync = vi.fn()
    mockFs.readSync = vi.fn()
    mockFs.closeSync = vi.fn()
  })

  describe('parseInstincts', () => {
    it('returns empty array when instincts directory does not exist', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      expect(parser.parseInstincts('/home/test/.claude/homunculus')).toEqual([])
    })

    it('parses a valid personal instinct YAML file', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('personal')) return ['test-instinct.yaml']
        return []
      })
      const yamlContent = `---
id: test-instinct
trigger: When writing async code
confidence: 0.85
domain: python
source: session-observation
---
## Problem
Async code can fail silently.

## Action
Always handle exceptions.`
      mockRegularFile(yamlContent)

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts).toHaveLength(1)
      expect(instincts[0].id).toBe('test-instinct')
      expect(instincts[0].confidence).toBe(0.85)
      expect(instincts[0].domain).toBe('python')
      expect(instincts[0].type).toBe('personal')
      expect(instincts[0].content).toContain('Async code')
    })

    it('parses inherited instincts with correct type', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('inherited')) return ['inherited-instinct.yaml']
        return []
      })
      mockRegularFile(`---
id: shared-pattern
trigger: Common trigger
confidence: 0.7
domain: general
source: team
---
Content here.`)

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts[0].type).toBe('inherited')
    })

    it('skips malformed YAML files without crashing', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('personal')) return ['good.yaml', 'bad.yaml']
        return []
      })
      mockFilesByPath({
        '/home/test/.claude/homunculus/instincts/personal/good.yaml':
          '---\nid: good\ntrigger: ok\nconfidence: 0.9\ndomain: test\nsource: test\n---\nContent.',
        // Unbalanced flow-mapping syntax — yaml.load() throws on this.
        '/home/test/.claude/homunculus/instincts/personal/bad.yaml':
          '---\nid: [unterminated\n---\nContent.',
      })

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts).toHaveLength(1)
      expect(instincts[0].id).toBe('good')
    })

    it.each([
      ['empty frontmatter', '---\n\n---\nbody text'],
      ['comment-only frontmatter', '---\n# just a comment\n---\nbody text'],
    ])('parses %s with defaults', (_name, raw) => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('personal')) return ['bare.yaml']
        return []
      })
      mockRegularFile(raw)

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts).toHaveLength(1)
      expect(instincts[0]).toMatchObject({
        id: 'bare',
        trigger: '',
        confidence: 0.5,
        domain: 'general',
        source: 'unknown',
        content: 'body text',
      })
    })

    it('lists an instinct whose frontmatter has a YAML date value', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('personal')) return ['dated.yaml']
        return []
      })
      mockRegularFile('---\nid: dated\ncreated: 2026-01-02\n---\nbody')

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts).toHaveLength(1)
      expect(instincts[0].id).toBe('dated')
    })

    it('skips a symlinked instinct file (never followed, H2)', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('personal')) return ['linked.yaml']
        return []
      })
      mockNonRegularFile()

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts).toHaveLength(0)
      expect(mockFs.openSync).not.toHaveBeenCalled()
    })
  })

  describe('parseRecentObservations', () => {
    it('returns empty array when file does not exist', () => {
      mockMissingFile()
      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
    })

    it('returns empty array for empty file', () => {
      mockRegularFile('')
      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
    })

    it('parses valid JSONL observations', () => {
      const lines = [
        JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', event: 'tool_complete', tool: 'bash', session: 'abc123' }),
        JSON.stringify({ timestamp: '2026-03-01T10:01:00Z', event: 'parse_error', tool: null, session: 'abc123', raw: 'error' }),
      ].join('\n')
      mockRegularFile(lines)

      const obs = parser.parseRecentObservations('/path/to/observations.jsonl', 50)
      expect(obs.length).toBeGreaterThan(0)
    })

    it('skips malformed JSONL lines without crashing', () => {
      const lines = 'not-json\n' + JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', event: 'ok', session: 'x' }) + '\n'
      mockRegularFile(lines)

      // Should not throw
      expect(() => parser.parseRecentObservations('/path/to/observations.jsonl', 50)).not.toThrow()
    })

    it('ignores a symlinked observations file and returns promptly (no hang, H2)', () => {
      mockNonRegularFile()
      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
      expect(mockFs.openSync).not.toHaveBeenCalled()
    })

    it('reads backwards in chunks reusing a single opened handle', () => {
      const lines = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', event: `evt-${i}`, session: 'x' }),
      ).join('\n')
      mockRegularFile(lines)

      parser.parseRecentObservations('/path/to/observations.jsonl', 50)
      // One open, and the same fd (3) closed exactly once — not re-opened per chunk.
      expect(mockFs.openSync).toHaveBeenCalledTimes(1)
      expect(mockFs.closeSync).toHaveBeenCalledTimes(1)
      expect(mockFs.closeSync).toHaveBeenCalledWith(3)
    })

    it('returns empty array when open fails after lstat succeeds (race)', () => {
      mockFs.lstatSync = vi.fn().mockReturnValue({ isFile: () => true })
      mockFs.openSync = vi.fn().mockImplementation(() => {
        throw new Error('ENOENT')
      })
      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
    })

    it('returns empty array when fstat fails on the freshly opened handle', () => {
      mockFs.lstatSync = vi.fn().mockReturnValue({ isFile: () => true })
      mockFs.openSync = vi.fn().mockReturnValue(3)
      mockFs.fstatSync = vi.fn().mockImplementation(() => {
        throw new Error('boom')
      })
      mockFs.closeSync = vi.fn()

      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
      expect(mockFs.closeSync).toHaveBeenCalledWith(3)
    })

    it('stops the backward read loop gracefully when a chunk read fails', () => {
      const lines = Array.from({ length: 3 }, (_, i) =>
        JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', event: `evt-${i}`, session: 'x' }),
      ).join('\n')
      const buf = Buffer.from(lines, 'utf-8')
      mockFs.lstatSync = vi.fn().mockReturnValue({ isFile: () => true })
      mockFs.openSync = vi.fn().mockReturnValue(3)
      mockFs.fstatSync = vi.fn().mockReturnValue({ isFile: () => true, size: buf.length })
      mockFs.readSync = vi.fn().mockImplementation(() => {
        throw new Error('EIO')
      })
      mockFs.closeSync = vi.fn()

      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
      expect(mockFs.closeSync).toHaveBeenCalledWith(3) // still closed despite the mid-loop failure
    })
  })

  describe('parseEvolvedArtifacts', () => {
    it('returns empty array when evolved directory does not exist', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      expect(parser.parseEvolvedArtifacts('/home/test/.claude/homunculus')).toEqual([])
    })

    it('parses agents, skills, commands', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('agents')) return ['my-agent.md']
        if (dir.includes('skills')) return ['my-skill.md']
        if (dir.includes('commands')) return ['my-command.md']
        return []
      })
      mockFs.statSync = vi.fn().mockReturnValue({ mtime: new Date('2026-03-01'), isFile: () => true, size: 10 })
      mockFilesByPath({
        '/home/test/.claude/homunculus/evolved/agents/my-agent.md': '# Content',
        '/home/test/.claude/homunculus/evolved/skills/my-skill.md': '# Content',
        '/home/test/.claude/homunculus/evolved/commands/my-command.md': '# Content',
      })

      const artifacts = parser.parseEvolvedArtifacts('/home/test/.claude/homunculus')
      expect(artifacts.some((a) => a.type === 'agent' && a.name === 'my-agent')).toBe(true)
      expect(artifacts.some((a) => a.type === 'skill' && a.name === 'my-skill')).toBe(true)
      expect(artifacts.some((a) => a.type === 'command' && a.name === 'my-command')).toBe(true)
    })

    it('skips a symlinked evolved artifact (never followed, H2)', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('agents')) return ['linked.md']
        return []
      })
      mockNonRegularFile()

      const artifacts = parser.parseEvolvedArtifacts('/home/test/.claude/homunculus')
      expect(artifacts).toHaveLength(0)
    })

    it('caps an oversized evolved artifact at the 1 MB read cap, then previews the first 500 chars', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('agents')) return ['huge.md']
        return []
      })
      mockFs.statSync = vi.fn().mockReturnValue({ mtime: new Date('2026-03-01'), isFile: () => true, size: 0 })
      const huge = 'x'.repeat(2 * 1024 * 1024)
      mockRegularFile(huge)

      const artifacts = parser.parseEvolvedArtifacts('/home/test/.claude/homunculus')
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].content).toHaveLength(500) // preview only, well under the 1 MB cap
      expect(artifacts[0].content).toBe('x'.repeat(500))
    })
  })

  describe('computeStats', () => {
    it('returns zero stats for empty inputs', () => {
      const stats = parser.computeStats([], [], [])
      expect(stats.totalInstincts).toBe(0)
      expect(stats.confidenceDistribution.high).toBe(0)
      expect(stats.crossWorkspacePatterns).toHaveLength(0)
    })

    it('computes confidence distribution correctly', () => {
      const instincts = [
        { id: 'a', confidence: 0.9, domain: 'python', type: 'personal' as const, trigger: '', source: '', content: '', filePath: '', lastModified: '' },
        { id: 'b', confidence: 0.6, domain: 'python', type: 'personal' as const, trigger: '', source: '', content: '', filePath: '', lastModified: '' },
        { id: 'c', confidence: 0.3, domain: 'go', type: 'inherited' as const, trigger: '', source: '', content: '', filePath: '', lastModified: '' },
      ]
      const stats = parser.computeStats(instincts, [], [])
      expect(stats.confidenceDistribution.high).toBe(1)
      expect(stats.confidenceDistribution.medium).toBe(1)
      expect(stats.confidenceDistribution.low).toBe(1)
    })

    it('detects cross-workspace patterns (domain with 2+ instincts)', () => {
      const instincts = [
        { id: 'a', confidence: 0.8, domain: 'python', type: 'personal' as const, trigger: '', source: '', content: '', filePath: '', lastModified: '' },
        { id: 'b', confidence: 0.7, domain: 'python', type: 'personal' as const, trigger: '', source: '', content: '', filePath: '', lastModified: '' },
        { id: 'c', confidence: 0.9, domain: 'go', type: 'personal' as const, trigger: '', source: '', content: '', filePath: '', lastModified: '' },
      ]
      const stats = parser.computeStats(instincts, [], [])
      expect(stats.crossWorkspacePatterns.some((p) => p.domain === 'python')).toBe(true)
      expect(stats.crossWorkspacePatterns.some((p) => p.domain === 'go')).toBe(false) // only 1
    })
  })
})
