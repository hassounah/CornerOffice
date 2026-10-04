import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { WorkspaceParserService, readMemoryDocsRoot, readPipelineBranches } from '@main/services/workspace-parser'

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'co-parser-test-'))
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

const SAMPLE_MEMORY_MD = `# Rix Memory

## Settings
- docs_root: /home/amer/my-project/docs
- next_feature_id: 5

## Project Context
My cool project description.

## Backlog
- Item one
- Item two

## Learned Conventions
- Use pnpm
`

const SAMPLE_PIPELINE_MD = `# Active Pipeline

- **Feature**: My Feature
- **Feature ID**: 0003
- **Pipeline**: full
- **Stage**: impl
- **Gate**: 2
- **Branch**: feat/my-feature
- **Plan file**: /path/to/plan.md
- **Task list**: /path/to/task-list.md
- **Started**: 2024-01-10
- **Fix cycles**: 1
`

const SAMPLE_HISTORY_MD = `# Shipped Features

## 0001-First Feature -- 2024-01-15
- **Pipeline**: full
- **Gates passed**: 3/3 passed
- **Fix cycles**: 0
- **Fix cycles (design)**: 0
- **Fix cycles (plan)**: 0
- **Fix cycles (impl)**: 0
- **Fix cycles (review)**: 0
- **Files changed**: src/main/index.ts
- **Tests**: 25 passing
- **Mode**: full-team (4 agents)
- **Key components**: MainProcess, Preload

## Second Feature -- 2024-02-20
- **Pipeline**: light
- **Gates passed**: 1/1 passed
- **Fix cycles**: 2
- **Files changed**: src/renderer/App.tsx
`

describe('WorkspaceParserService', () => {
  let tmpDir: string
  const svc = new WorkspaceParserService()

  beforeEach(() => {
    tmpDir = mkTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── parseMemoryMd ───────────────────────────────────────────────────────────

  describe('parseMemoryMd', () => {
    it('extracts docs_root and next_feature_id', () => {
      const p = path.join(tmpDir, 'memory.md')
      writeFile(p, SAMPLE_MEMORY_MD)
      const result = svc.parseMemoryMd(p)
      expect(result.docsRoot).toBe('/home/amer/my-project/docs')
      expect(result.nextFeatureId).toBe(5)
    })

    it('extracts project context section', () => {
      const p = path.join(tmpDir, 'memory.md')
      writeFile(p, SAMPLE_MEMORY_MD)
      const result = svc.parseMemoryMd(p)
      expect(result.projectContext).toContain('My cool project description')
    })

    it('returns null/empty defaults for missing file', () => {
      const result = svc.parseMemoryMd('/nonexistent/memory.md')
      expect(result.docsRoot).toBeNull()
      expect(result.nextFeatureId).toBeNull()
      expect(result.projectContext).toBe('')
    })

    it('returns null for missing settings fields', () => {
      const p = path.join(tmpDir, 'memory.md')
      writeFile(p, '# Rix Memory\n\n## Project Context\nSome context.\n')
      const result = svc.parseMemoryMd(p)
      expect(result.docsRoot).toBeNull()
      expect(result.nextFeatureId).toBeNull()
      expect(result.projectContext).toBe('Some context.')
    })
  })

  // ── scanPipelinesDir ────────────────────────────────────────────────────────

  describe('scanPipelinesDir', () => {
    it('returns empty result for non-existent directory', () => {
      expect(svc.scanPipelinesDir('/nonexistent/pipelines')).toEqual({ active: [], parked: [] })
    })

    it('returns empty result for empty directory', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      fs.mkdirSync(pipelinesDir)
      expect(svc.scanPipelinesDir(pipelinesDir)).toEqual({ active: [], parked: [] })
    })

    it('classifies .md with matching .lock as active', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      writeFile(path.join(pipelinesDir, '0003-my-feature.md'), SAMPLE_PIPELINE_MD)
      writeFile(path.join(pipelinesDir, '0003-my-feature.lock'), '')
      const result = svc.scanPipelinesDir(pipelinesDir)
      expect(result.active).toHaveLength(1)
      expect(result.parked).toHaveLength(0)
      expect(result.active[0].featureName).toBe('My Feature')
    })

    it('classifies .md without .lock as parked', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      writeFile(path.join(pipelinesDir, '0003-my-feature.md'), SAMPLE_PIPELINE_MD)
      const result = svc.scanPipelinesDir(pipelinesDir)
      expect(result.active).toHaveLength(0)
      expect(result.parked).toHaveLength(1)
      expect(result.parked[0].featureName).toBe('My Feature')
    })

    it('sets slug from filename stem', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      writeFile(path.join(pipelinesDir, '0003-my-feature.md'), SAMPLE_PIPELINE_MD)
      writeFile(path.join(pipelinesDir, '0003-my-feature.lock'), '')
      const result = svc.scanPipelinesDir(pipelinesDir)
      expect(result.active[0].slug).toBe('0003-my-feature')
    })

    it('splits multiple pipelines by lock file presence', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      writeFile(path.join(pipelinesDir, '0003-my-feature.md'), SAMPLE_PIPELINE_MD)
      writeFile(path.join(pipelinesDir, '0003-my-feature.lock'), '')
      writeFile(path.join(pipelinesDir, '0004-other-feature.md'), SAMPLE_PIPELINE_MD)
      const result = svc.scanPipelinesDir(pipelinesDir)
      expect(result.active).toHaveLength(1)
      expect(result.parked).toHaveLength(1)
    })

    it('ignores non-.md files', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      writeFile(path.join(pipelinesDir, 'notes.txt'), 'not a pipeline')
      writeFile(path.join(pipelinesDir, '0003-my-feature.lock'), '')
      const result = svc.scanPipelinesDir(pipelinesDir)
      expect(result.active).toHaveLength(0)
      expect(result.parked).toHaveLength(0)
    })

    it('skips .md files with no Feature field', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      writeFile(path.join(pipelinesDir, 'bad.md'), '# Pipeline\n\n- **Pipeline**: full\n')
      writeFile(path.join(pipelinesDir, 'bad.lock'), '')
      const result = svc.scanPipelinesDir(pipelinesDir)
      expect(result.active).toHaveLength(0)
      expect(result.parked).toHaveLength(0)
    })

    it('parses all pipeline fields correctly', () => {
      const pipelinesDir = path.join(tmpDir, 'pipelines')
      writeFile(path.join(pipelinesDir, '0003-my-feature.md'), SAMPLE_PIPELINE_MD)
      writeFile(path.join(pipelinesDir, '0003-my-feature.lock'), '')
      const result = svc.scanPipelinesDir(pipelinesDir)
      const p = result.active[0]
      expect(p.featureName).toBe('My Feature')
      expect(p.featureId).toBe('0003')
      expect(p.pipelineType).toBe('full')
      expect(p.stage).toBe('impl')
      expect(p.gate).toBe(2)
      expect(p.branch).toBe('feat/my-feature')
      expect(p.fixCycles).toBe(1)
      expect(p.started).toBe('2024-01-10')
    })
  })

  // ── parseHistoryMd ──────────────────────────────────────────────────────────

  describe('parseHistoryMd', () => {
    it('parses multiple features', () => {
      const p = path.join(tmpDir, 'history.md')
      writeFile(p, SAMPLE_HISTORY_MD)
      const results = svc.parseHistoryMd(p)
      expect(results).toHaveLength(2)
    })

    it('parses ID from "0001-name" header format', () => {
      const p = path.join(tmpDir, 'history.md')
      writeFile(p, SAMPLE_HISTORY_MD)
      const results = svc.parseHistoryMd(p)
      expect(results[0].id).toBe('0001')
      expect(results[0].name).toBe('First Feature')
    })

    it('computes quality score from fix cycles', () => {
      const p = path.join(tmpDir, 'history.md')
      writeFile(p, SAMPLE_HISTORY_MD)
      const results = svc.parseHistoryMd(p)
      expect(results[0].qualityScore).toBe(100) // 0 fix cycles
      expect(results[1].qualityScore).toBe(80)  // 2 fix cycles -> 100 - 20
    })

    it('returns empty array for missing file', () => {
      expect(svc.parseHistoryMd('/nonexistent/history.md')).toEqual([])
    })

    it('skips malformed sections gracefully', () => {
      const p = path.join(tmpDir, 'history.md')
      writeFile(p, '# Shipped Features\n\n## Bad Entry no date\nsome content\n\n## Valid -- 2024-03-01\n- **Pipeline**: direct\n')
      const results = svc.parseHistoryMd(p)
      expect(results).toHaveLength(1)
      expect(results[0].shippedDate).toBe('2024-03-01')
    })
  })

  describe('findReadme', () => {
    it('returns content for README.md (standard case)', () => {
      writeFile(path.join(tmpDir, 'README.md'), '# My Project\nHello world.')
      expect(svc.findReadme(tmpDir)).toBe('# My Project\nHello world.')
    })

    it('returns content for readme.md (lowercase)', () => {
      writeFile(path.join(tmpDir, 'readme.md'), '# lowercase readme')
      expect(svc.findReadme(tmpDir)).toBe('# lowercase readme')
    })

    it('returns content for Readme.md (mixed case)', () => {
      writeFile(path.join(tmpDir, 'Readme.md'), '# Mixed case')
      expect(svc.findReadme(tmpDir)).toBe('# Mixed case')
    })

    it('returns content for README.MD (uppercase extension)', () => {
      writeFile(path.join(tmpDir, 'README.MD'), '# All caps')
      expect(svc.findReadme(tmpDir)).toBe('# All caps')
    })

    it('returns null when no README.md exists', () => {
      expect(svc.findReadme(tmpDir)).toBeNull()
    })

    it('returns null for non-existent workspace directory', () => {
      expect(svc.findReadme(path.join(tmpDir, 'nonexistent'))).toBeNull()
    })

    it('returns null when README.md exceeds 2 MB', () => {
      const largeContent = 'x'.repeat(2 * 1024 * 1024 + 1)
      writeFile(path.join(tmpDir, 'README.md'), largeContent)
      expect(svc.findReadme(tmpDir)).toBeNull()
    })

    it('returns null when README.md is a directory not a file', () => {
      fs.mkdirSync(path.join(tmpDir, 'README.md'))
      expect(svc.findReadme(tmpDir)).toBeNull()
    })

    it('returns content up to exactly 2 MB (boundary)', () => {
      const content = 'x'.repeat(2 * 1024 * 1024)
      writeFile(path.join(tmpDir, 'README.md'), content)
      expect(svc.findReadme(tmpDir)).toBe(content)
    })
  })

  // ── H2 hardened .rix reads (§10.8, SEC-L4) ─────────────────────────────────

  describe('capped, no-follow .rix reads (H2)', () => {
    it.skipIf(process.platform === 'win32')('ignores a symlinked .rix/memory.md', () => {
      const rixDir = path.join(tmpDir, '.rix')
      fs.mkdirSync(rixDir, { recursive: true })
      const realFile = path.join(tmpDir, 'outside-memory.md')
      writeFile(realFile, SAMPLE_MEMORY_MD)
      const linkPath = path.join(rixDir, 'memory.md')
      try {
        fs.symlinkSync(realFile, linkPath)
      } catch {
        return // symlinks unsupported on this filesystem
      }

      const result = svc.parseMemoryMd(linkPath)
      expect(result.docsRoot).toBeNull()
      expect(result.nextFeatureId).toBeNull()
    })

    it.skipIf(process.platform === 'win32')('a .rix/pipelines symlink to another directory yields no parsed pipelines from it', () => {
      const rixDir = path.join(tmpDir, '.rix')
      fs.mkdirSync(rixDir, { recursive: true })
      const outsideDir = path.join(tmpDir, 'outside-pipelines')
      writeFile(path.join(outsideDir, '0099-evil.md'), SAMPLE_PIPELINE_MD)
      const pipelinesLink = path.join(rixDir, 'pipelines')
      try {
        fs.symlinkSync(outsideDir, pipelinesLink)
      } catch {
        return
      }

      const result = svc.scanPipelinesDir(pipelinesLink)
      expect(result.active).toHaveLength(0)
      expect(result.parked).toHaveLength(0)
    })

    it.skipIf(process.platform === 'win32')('ignores a symlinked .rix/history.md', () => {
      const rixDir = path.join(tmpDir, '.rix')
      fs.mkdirSync(rixDir, { recursive: true })
      const realFile = path.join(tmpDir, 'outside-history.md')
      writeFile(realFile, SAMPLE_HISTORY_MD)
      const linkPath = path.join(rixDir, 'history.md')
      try {
        fs.symlinkSync(realFile, linkPath)
      } catch {
        return
      }

      expect(svc.parseHistoryMd(linkPath)).toEqual([])
    })

    it('caps an oversized memory.md at 1 MB (returns defaults rather than reading it whole)', () => {
      const rixDir = path.join(tmpDir, '.rix')
      const p = path.join(rixDir, 'memory.md')
      // Valid settings line placed AFTER the 1 MB cap — never reached.
      const oversized = '#'.repeat(1024 * 1024 + 10) + '\n- docs_root: /should/not/be/read\n'
      writeFile(p, oversized)

      const result = svc.parseMemoryMd(p)
      expect(result.docsRoot).toBeNull()
    })

    it('a FIFO pipeline card does not hang scanPipelinesDir', () => {
      const rixDir = path.join(tmpDir, '.rix')
      const pipelinesDir = path.join(rixDir, 'pipelines')
      fs.mkdirSync(pipelinesDir, { recursive: true })
      const fifoPath = path.join(pipelinesDir, '0001-fifo.md')
      try {
        execFileSync('mkfifo', [fifoPath])
      } catch {
        return // mkfifo unsupported on this platform
      }

      const result = svc.scanPipelinesDir(pipelinesDir)
      expect(result.active).toHaveLength(0)
      expect(result.parked).toHaveLength(0)
    })
  })

  describe('readMemoryDocsRoot', () => {
    it('returns the docs_root setting from .rix/memory.md', () => {
      writeFile(path.join(tmpDir, '.rix', 'memory.md'), SAMPLE_MEMORY_MD)
      expect(readMemoryDocsRoot(tmpDir)).toBe('/home/amer/my-project/docs')
    })

    it('returns null for a relative docs_root (SEC-M1)', () => {
      writeFile(path.join(tmpDir, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: ../other/docs\n')
      expect(readMemoryDocsRoot(tmpDir)).toBeNull()
    })

    it('collapses .. segments in an absolute docs_root (SEC-M1)', () => {
      writeFile(path.join(tmpDir, '.rix', 'memory.md'), '# Rix Memory\n\n## Settings\n- docs_root: /repo/docs/../../other\n')
      expect(readMemoryDocsRoot(tmpDir)).toBe('/other')
    })

    it('returns null when memory.md has no docs_root setting', () => {
      writeFile(path.join(tmpDir, '.rix', 'memory.md'), '# Rix Memory\n\n## Project Context\nSome context.\n')
      expect(readMemoryDocsRoot(tmpDir)).toBeNull()
    })

    it('returns null when .rix/memory.md does not exist', () => {
      expect(readMemoryDocsRoot(tmpDir)).toBeNull()
    })

    it.skipIf(process.platform === 'win32')('ignores a symlinked memory.md (H2)', () => {
      const rixDir = path.join(tmpDir, '.rix')
      fs.mkdirSync(rixDir, { recursive: true })
      const realFile = path.join(tmpDir, 'outside-memory.md')
      writeFile(realFile, SAMPLE_MEMORY_MD)
      try {
        fs.symlinkSync(realFile, path.join(rixDir, 'memory.md'))
      } catch {
        return
      }

      expect(readMemoryDocsRoot(tmpDir)).toBeNull()
    })
  })

  describe('readPipelineBranches', () => {
    it('returns branch names from both active and parked pipeline cards', () => {
      const pipelinesDir = path.join(tmpDir, '.rix', 'pipelines')
      writeFile(path.join(pipelinesDir, '0003-my-feature.md'), SAMPLE_PIPELINE_MD) // Branch: feat/my-feature
      writeFile(path.join(pipelinesDir, '0003-my-feature.lock'), '') // active
      const parkedMd = SAMPLE_PIPELINE_MD.replace('feat/my-feature', 'feat/other-feature')
      writeFile(path.join(pipelinesDir, '0004-other-feature.md'), parkedMd) // parked (no .lock)

      expect(readPipelineBranches(tmpDir)).toEqual(expect.arrayContaining(['feat/my-feature', 'feat/other-feature']))
      expect(readPipelineBranches(tmpDir)).toHaveLength(2)
    })

    it('omits a card with no Branch field (null branch)', () => {
      const pipelinesDir = path.join(tmpDir, '.rix', 'pipelines')
      const noBranchMd = SAMPLE_PIPELINE_MD.split('\n').filter((l) => !l.startsWith('- **Branch**')).join('\n')
      writeFile(path.join(pipelinesDir, '0003-my-feature.md'), noBranchMd)
      writeFile(path.join(pipelinesDir, '0003-my-feature.lock'), '')

      expect(readPipelineBranches(tmpDir)).toEqual([])
    })

    it('returns an empty array when .rix/pipelines does not exist', () => {
      expect(readPipelineBranches(tmpDir)).toEqual([])
    })
  })

})
