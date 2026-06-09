import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { DocsParserService } from '@main/services/docs-parser'

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'co-docs-test-'))
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}

function touch(p: string, content = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

describe('DocsParserService', () => {
  let tmpDir: string
  const svc = new DocsParserService()

  beforeEach(() => {
    tmpDir = mkTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── scanTodoDir ─────────────────────────────────────────────────────────────

  describe('scanTodoDir', () => {
    it('returns plain .md files as IdeationItems', () => {
      touch(path.join(tmpDir, 'TODO', 'webhook-auth-prd.md'))
      touch(path.join(tmpDir, 'TODO', 'rate-limiting-idea.md'))
      const result = svc.scanTodoDir(path.join(tmpDir, 'TODO'))
      expect(result.ideationItems).toHaveLength(2)
      expect(result.ideationItems[0].filename).toContain('.md')
      expect(result.ideationItems[0].title).toBeTruthy()
    })

    it('title-cases the ideation item name', () => {
      touch(path.join(tmpDir, 'TODO', 'some-cool-feature.md'))
      const result = svc.scanTodoDir(path.join(tmpDir, 'TODO'))
      expect(result.ideationItems[0].title).toBe('Some Cool Feature')
    })

    it('returns numbered dirs as Feature with status todo', () => {
      mkdir(path.join(tmpDir, 'TODO', '0005-rate-limiting'))
      const result = svc.scanTodoDir(path.join(tmpDir, 'TODO'))
      expect(result.features).toHaveLength(1)
      expect(result.features[0].id).toBe('0005')
      expect(result.features[0].name).toBe('Rate Limiting')
      expect(result.features[0].status).toBe('todo')
    })

    it('ignores non-numbered directories', () => {
      mkdir(path.join(tmpDir, 'TODO', 'random-dir'))
      const result = svc.scanTodoDir(path.join(tmpDir, 'TODO'))
      expect(result.features).toHaveLength(0)
    })

    it('returns empty results for missing directory', () => {
      const result = svc.scanTodoDir('/nonexistent/TODO')
      expect(result.ideationItems).toEqual([])
      expect(result.features).toEqual([])
    })
  })

  // ── scanInProgressDir ───────────────────────────────────────────────────────

  describe('scanInProgressDir', () => {
    it('returns numbered dirs as Feature with status in_progress', () => {
      mkdir(path.join(tmpDir, 'IN_PROGRESS', '0001-corner-office-app'))
      mkdir(path.join(tmpDir, 'IN_PROGRESS', '0002-better-auth'))
      const results = svc.scanInProgressDir(path.join(tmpDir, 'IN_PROGRESS'))
      expect(results).toHaveLength(2)
      expect(results.every((f) => f.status === 'in_progress')).toBe(true)
    })

    it('ignores plain .md files in IN_PROGRESS', () => {
      touch(path.join(tmpDir, 'IN_PROGRESS', 'README.md'))
      mkdir(path.join(tmpDir, 'IN_PROGRESS', '0001-my-feature'))
      const results = svc.scanInProgressDir(path.join(tmpDir, 'IN_PROGRESS'))
      expect(results).toHaveLength(1)
    })

    it('returns empty array for missing directory', () => {
      expect(svc.scanInProgressDir('/nonexistent')).toEqual([])
    })
  })

  // ── scanDoneDir ─────────────────────────────────────────────────────────────

  describe('scanDoneDir', () => {
    it('returns numbered dirs as Feature with status done', () => {
      mkdir(path.join(tmpDir, 'DONE', '0001-shipped-feature'))
      const results = svc.scanDoneDir(path.join(tmpDir, 'DONE'))
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('done')
      expect(results[0].id).toBe('0001')
      expect(results[0].name).toBe('Shipped Feature')
    })

    it('ignores non-numbered dirs', () => {
      mkdir(path.join(tmpDir, 'DONE', 'legacy-feature'))
      const results = svc.scanDoneDir(path.join(tmpDir, 'DONE'))
      expect(results).toHaveLength(0)
    })
  })

  // ── scanDocsRoot ────────────────────────────────────────────────────────────

  describe('scanDocsRoot', () => {
    it('aggregates features from all three directories', () => {
      mkdir(path.join(tmpDir, 'TODO', '0005-idea'))
      mkdir(path.join(tmpDir, 'IN_PROGRESS', '0001-wip'))
      mkdir(path.join(tmpDir, 'DONE', '0002-done'))
      touch(path.join(tmpDir, 'TODO', 'brainstorm.md'))

      const result = svc.scanDocsRoot(tmpDir)
      expect(result.features).toHaveLength(3)
      expect(result.ideationItems).toHaveLength(1)
    })

    it('handles completely missing docs_root gracefully', () => {
      const result = svc.scanDocsRoot('/nonexistent/docs')
      expect(result.features).toEqual([])
      expect(result.ideationItems).toEqual([])
    })

    it('handles partial directory structure (only TODO exists)', () => {
      touch(path.join(tmpDir, 'TODO', 'idea.md'))
      const result = svc.scanDocsRoot(tmpDir)
      expect(result.ideationItems).toHaveLength(1)
      expect(result.features).toEqual([])
    })
  })
})
