import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HomunculusParserService } from '../main/services/homunculus-parser'

vi.mock('fs')
import fs from 'fs'
const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

// gray-matter is NOT mocked — we test real YAML parsing

describe('HomunculusParserService', () => {
  let parser: HomunculusParserService

  beforeEach(() => {
    vi.clearAllMocks()
    parser = new HomunculusParserService()
    mockFs.existsSync = vi.fn().mockReturnValue(false)
    mockFs.readdirSync = vi.fn().mockReturnValue([])
    mockFs.readFileSync = vi.fn()
    mockFs.statSync = vi.fn().mockReturnValue({ mtime: new Date('2026-03-01'), isFile: () => true, size: 0 })
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
      mockFs.readFileSync = vi.fn().mockReturnValue(yamlContent)
      mockFs.statSync = vi.fn().mockReturnValue({ mtime: new Date('2026-03-01'), isFile: () => true, size: 100 })

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
      mockFs.readFileSync = vi.fn().mockReturnValue(`---
id: shared-pattern
trigger: Common trigger
confidence: 0.7
domain: general
source: team
---
Content here.`)
      mockFs.statSync = vi.fn().mockReturnValue({ mtime: new Date('2026-03-01'), isFile: () => true, size: 50 })

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts[0].type).toBe('inherited')
    })

    it('skips malformed YAML files without crashing', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.readdirSync = vi.fn().mockImplementation((dir: string) => {
        if (dir.includes('personal')) return ['good.yaml', 'bad.yaml']
        return []
      })
      mockFs.readFileSync = vi.fn().mockImplementation((filePath: string) => {
        if (String(filePath).includes('bad')) throw new Error('read error')
        return `---\nid: good\ntrigger: ok\nconfidence: 0.9\ndomain: test\nsource: test\n---\nContent.`
      })
      mockFs.statSync = vi.fn().mockReturnValue({ mtime: new Date(), isFile: () => true, size: 50 })

      const instincts = parser.parseInstincts('/home/test/.claude/homunculus')
      expect(instincts).toHaveLength(1)
      expect(instincts[0].id).toBe('good')
    })
  })

  describe('parseRecentObservations', () => {
    it('returns empty array when file does not exist', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
    })

    it('returns empty array for empty file', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: 0 })
      expect(parser.parseRecentObservations('/path/to/observations.jsonl', 50)).toEqual([])
    })

    it('parses valid JSONL observations', () => {
      const lines = [
        JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', event: 'tool_complete', tool: 'bash', session: 'abc123' }),
        JSON.stringify({ timestamp: '2026-03-01T10:01:00Z', event: 'parse_error', tool: null, session: 'abc123', raw: 'error' }),
      ].join('\n')

      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: Buffer.byteLength(lines, 'utf-8') })
      mockFs.openSync = vi.fn().mockReturnValue(3)
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        Buffer.from(lines, 'utf-8').copy(buf)
        return buf.length
      })
      mockFs.closeSync = vi.fn()

      const obs = parser.parseRecentObservations('/path/to/observations.jsonl', 50)
      expect(obs.length).toBeGreaterThan(0)
    })

    it('skips malformed JSONL lines without crashing', () => {
      const lines = 'not-json\n' + JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', event: 'ok', session: 'x' }) + '\n'
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.statSync = vi.fn().mockReturnValue({ size: Buffer.byteLength(lines, 'utf-8') })
      mockFs.openSync = vi.fn().mockReturnValue(3)
      mockFs.readSync = vi.fn().mockImplementation((_fd: number, buf: Buffer) => {
        Buffer.from(lines, 'utf-8').copy(buf)
        return buf.length
      })
      mockFs.closeSync = vi.fn()

      // Should not throw
      expect(() => parser.parseRecentObservations('/path/to/observations.jsonl', 50)).not.toThrow()
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
      mockFs.readFileSync = vi.fn().mockReturnValue('# Content')

      const artifacts = parser.parseEvolvedArtifacts('/home/test/.claude/homunculus')
      expect(artifacts.some((a) => a.type === 'agent' && a.name === 'my-agent')).toBe(true)
      expect(artifacts.some((a) => a.type === 'skill' && a.name === 'my-skill')).toBe(true)
      expect(artifacts.some((a) => a.type === 'command' && a.name === 'my-command')).toBe(true)
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
