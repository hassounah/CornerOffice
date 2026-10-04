import fs from 'fs'
import path from 'path'
import { readRegularFileCappedSync } from './safe-fs'
import type { Pipeline, ShippedFeature, FixCycleBreakdown } from '../types/workspace'

// 1 MB cap for .rix files (H2, §10.8) — memory.md, history.md, and each
// pipeline card.
const RIX_READ_CAP = 1024 * 1024

// Regex for memory.md settings section
const DOCS_ROOT_RE = /^-\s+docs_root:\s*(.+)$/m
const NEXT_FEATURE_ID_RE = /^-\s+next_feature_id:\s*(\d+)$/m

// Regex for pipeline .md card key-value pairs: "- **Key**: Value"
const KV_RE = /^-\s+\*\*([^*]+)\*\*:\s*(.*)$/

// Regex for history.md section headers: "## Name -- 2024-01-15"
const HISTORY_SECTION_RE = /^##\s+(.+?)\s+--\s+(\d{4}-\d{2}-\d{2})\s*$/m

// History section bullet field regexes
const PIPELINE_TYPE_RE = /^-\s+\*\*Pipeline\*\*:\s*(.+)$/im
const GATES_RE = /^-\s+\*\*Gates passed\*\*:\s*(.+)$/im
const FIX_CYCLES_TOTAL_RE = /^-\s+\*\*Fix cycles\*\*:\s*(\d+)$/im
const FIX_DESIGN_RE = /^-\s+\*\*Fix cycles \(design\)\*\*:\s*(\d+)$/im
const FIX_PLAN_RE = /^-\s+\*\*Fix cycles \(plan\)\*\*:\s*(\d+)$/im
const FIX_IMPL_RE = /^-\s+\*\*Fix cycles \(impl\)\*\*:\s*(\d+)$/im
const FIX_REVIEW_RE = /^-\s+\*\*Fix cycles \(review\)\*\*:\s*(\d+)$/im
const FILES_RE = /^-\s+\*\*Files changed\*\*:\s*(.+)$/im
const TESTS_RE = /^-\s+\*\*Tests\*\*:\s*(.+)$/im
const MODE_RE = /^-\s+\*\*Mode\*\*:\s*(.+)$/im
const KEY_COMPONENTS_RE = /^-\s+\*\*Key components\*\*:\s*(.+)$/im
const FEATURE_ID_RE = /^-\s+\*\*Feature ID\*\*:\s*(.+)$/im

export interface PipelinesScanResult {
  active: Pipeline[];
  parked: Pipeline[];
}

export interface MemoryMdData {
  docsRoot: string | null
  nextFeatureId: number | null
  projectContext: string
  backlog: string
  learnedConventions: string
}

/**
 * Capped, no-follow read of a file under `.rix` (H2, SEC-L4): `root` pins
 * containment to `.rix` itself, so a symlinked subdirectory (e.g.
 * `.rix/pipelines`) can't redirect a read outside it. Returns null for a
 * symlink, FIFO, directory, oversized file, or anything outside root.
 */
function readRixFileSafe(root: string, filePath: string): string | null {
  const capped = readRegularFileCappedSync(filePath, RIX_READ_CAP, { root })
  return capped === null ? null : capped.buf.toString('utf-8')
}

function extractSection(content: string, sectionName: string): string {
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'm')
  const match = re.exec(content)
  if (!match) return ''
  const start = match.index + match[0].length
  const nextSection = /^##\s+/m.exec(content.slice(start))
  const end = nextSection ? start + nextSection.index : content.length
  return content.slice(start, end).trim()
}

function parsePipelineType(val: string): 'direct' | 'light' | 'full' {
  const v = val.toLowerCase().trim()
  if (v === 'direct') return 'direct'
  if (v === 'light') return 'light'
  return 'full'
}

function parseFixCycles(sectionText: string): FixCycleBreakdown {
  const total = parseInt(FIX_CYCLES_TOTAL_RE.exec(sectionText)?.[1] ?? '0', 10)
  const design = parseInt(FIX_DESIGN_RE.exec(sectionText)?.[1] ?? '0', 10)
  const plan = parseInt(FIX_PLAN_RE.exec(sectionText)?.[1] ?? '0', 10)
  const impl = parseInt(FIX_IMPL_RE.exec(sectionText)?.[1] ?? '0', 10)
  const reviewFixes = parseInt(FIX_REVIEW_RE.exec(sectionText)?.[1] ?? '0', 10)
  return { design, plan, impl, reviewFixes, total }
}

export class WorkspaceParserService {
  /**
   * Parse memory.md — extract settings, project context, backlog, conventions.
   * Returns defaults for missing sections, never throws.
   */
  parseMemoryMd(filePath: string): MemoryMdData {
    const content = readRixFileSafe(path.dirname(filePath), filePath)
    if (!content) {
      return { docsRoot: null, nextFeatureId: null, projectContext: '', backlog: '', learnedConventions: '' }
    }

    const docsRootMatch = DOCS_ROOT_RE.exec(content)
    const nextFeatureIdMatch = NEXT_FEATURE_ID_RE.exec(content)

    return {
      docsRoot: docsRootMatch ? docsRootMatch[1].trim() : null,
      nextFeatureId: nextFeatureIdMatch ? parseInt(nextFeatureIdMatch[1], 10) : null,
      projectContext: extractSection(content, 'Project Context'),
      backlog: extractSection(content, 'Backlog'),
      learnedConventions: extractSection(content, 'Learned Conventions'),
    }
  }

  /**
   * Scan .rix/pipelines/ directory. For each .md file, check if a matching
   * .lock sentinel file exists. Lock present = active, absent = parked.
   */
  scanPipelinesDir(dirPath: string): PipelinesScanResult {
    let entries: string[]
    try {
      entries = fs.readdirSync(dirPath)
    } catch {
      return { active: [], parked: [] }
    }

    const entrySet = new Set(entries)
    const active: Pipeline[] = []
    const parked: Pipeline[] = []
    const rixRoot = path.dirname(dirPath) // dirPath is `.rix/pipelines`; root is `.rix`

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const filePath = path.join(dirPath, entry)
      const content = readRixFileSafe(rixRoot, filePath)
      if (!content) continue

      const pipeline = this._parsePipelineContent(content)
      if (!pipeline) continue

      const slug = path.basename(entry, '.md')
      if (!/^[a-zA-Z0-9_-]+$/.test(slug)) continue
      pipeline.slug = slug

      if (entrySet.has(`${slug}.lock`)) {
        active.push(pipeline)
      } else {
        parked.push(pipeline)
      }
    }

    return { active, parked }
  }

  /**
   * Parse history.md — returns array of ShippedFeature, empty array if not found.
   */
  parseHistoryMd(filePath: string): ShippedFeature[] {
    const content = readRixFileSafe(path.dirname(filePath), filePath)
    if (!content) return []

    const features: ShippedFeature[] = []
    // Split on ## headings
    const sections = content.split(/^(?=##\s)/m).filter((s) => s.trim())

    for (const section of sections) {
      // Skip title section ("# Shipped Features")
      if (section.startsWith('#') && !section.startsWith('##')) continue

      const headerMatch = HISTORY_SECTION_RE.exec(section)
      if (!headerMatch) continue

      try {
        const rawName = headerMatch[1].trim()
        const shippedDate = headerMatch[2]

        // Name may be "0001-Feature Name" or just "Feature Name"
        let id: string | null = null
        let name = rawName
        const idNameMatch = /^(\d{4})-(.+)$/.exec(rawName)
        if (idNameMatch) {
          id = idNameMatch[1]
          name = idNameMatch[2].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        }

        const pipelineTypeRaw = PIPELINE_TYPE_RE.exec(section)?.[1]?.trim()
        const pipelineType = parsePipelineType(pipelineTypeRaw ?? 'full')
        const fixCycles = parseFixCycles(section)
        const gatesPassed = GATES_RE.exec(section)?.[1]?.trim() ?? '0/0 passed'
        const filesChanged = FILES_RE.exec(section)?.[1]?.trim() ?? ''
        const testsInfo = TESTS_RE.exec(section)?.[1]?.trim() ?? null
        const mode = MODE_RE.exec(section)?.[1]?.trim() ?? null
        const keyComponents = KEY_COMPONENTS_RE.exec(section)?.[1]?.trim() ?? null
        const featureIdOverride = FEATURE_ID_RE.exec(section)?.[1]?.trim()
        const qualityScore = Math.max(0, 100 - fixCycles.total * 10)

        features.push({
          id: featureIdOverride ?? id,
          name,
          shippedDate,
          pipelineType,
          gatesPassed,
          fixCycles,
          filesChanged,
          testsInfo,
          mode,
          keyComponents,
          qualityScore,
        })
      } catch {
        // Skip malformed sections gracefully
        continue
      }
    }

    return features
  }

  /**
   * Detect and read README.md at the workspace root (case-insensitive).
   * Returns null if no README found, file is not a regular file, size > 2 MB,
   * or any filesystem error occurs.
   */
  findReadme(workspacePath: string): string | null {
    const README_MAX_SIZE = 2 * 1024 * 1024 // 2 MB
    try {
      const entries = fs.readdirSync(workspacePath)
      const match = entries.find((e) => e.toLowerCase() === 'readme.md')
      if (!match) return null
      const fullPath = path.join(workspacePath, match)
      const stat = fs.statSync(fullPath)
      if (!stat.isFile() || stat.size > README_MAX_SIZE) return null
      return fs.readFileSync(fullPath, 'utf-8')
    } catch {
      return null
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _parsePipelineContent(content: string): Pipeline | null {
    const kvMap: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const m = KV_RE.exec(line)
      if (m) {
        kvMap[m[1].toLowerCase().trim()] = m[2].trim()
      }
    }

    const featureName = kvMap['feature'] ?? kvMap['feature name']
    if (!featureName) return null

    const pipelineTypeRaw = kvMap['pipeline'] ?? ''
    const pipelineType = parsePipelineType(pipelineTypeRaw)

    const gateRaw = kvMap['gate']
    const gate = gateRaw ? parseInt(gateRaw, 10) : null
    const parkedAtRaw = kvMap['parked']
    const started = kvMap['started'] ?? new Date().toISOString().slice(0, 10)
    const fixCycles = parseInt(kvMap['fix cycles'] ?? '0', 10)

    return {
      slug: '',               // set by caller (scanPipelinesDir)
      featureName,
      featureId: kvMap['feature id'] ?? null,
      pipelineType,
      stage: kvMap['stage'] ?? '',
      gate: gate !== null && !isNaN(gate) ? gate : null,
      branch: kvMap['branch'] ?? null,
      planFile: kvMap['plan file'] ?? null,
      taskList: kvMap['task list'] ?? null,
      started,
      fixCycles,
      parkedAt: parkedAtRaw ?? null,
      lastDecision: kvMap['last decision'] ?? null,
    }
  }
}

/**
 * Reads just `.rix/memory.md`'s `docs_root` setting, for 3.4's docs_root
 * mount-source derivation (host-side docs_root vs the workspace default) —
 * a small, dependency-free helper so callers that only need this one field
 * don't have to construct a full `WorkspaceParserService` and parse every
 * memory.md section. Same capped, no-follow read as `parseMemoryMd`
 * (H2, SEC-L4): null for a missing, symlinked, oversized or unreadable file.
 */
export function readMemoryDocsRoot(wsPath: string): string | null {
  const rixRoot = path.join(wsPath, '.rix')
  const memoryMdPath = path.join(rixRoot, 'memory.md')
  const content = readRixFileSafe(rixRoot, memoryMdPath)
  if (!content) return null
  const match = DOCS_ROOT_RE.exec(content)
  if (!match) return null
  // SEC-M1: a relative value has no trustworthy base; resolve() collapses `..` segments
  // so the caller's inside-repo test can't be bypassed lexically.
  const raw = match[1].trim()
  return path.isAbsolute(raw) ? path.resolve(raw) : null
}

/**
 * Branch names from every pipeline card (active and parked) under
 * `<wsPath>/.rix/pipelines` — for 3.5/3.7's unmerged-branch detection
 * (SEC-L5: the caller only ever compares these against git's own
 * `for-each-ref` output, never passes them to a git command). Same
 * dependency-free shape as `readMemoryDocsRoot`: a caller that only needs
 * branch names doesn't have to construct a full `WorkspaceParserService`.
 */
export function readPipelineBranches(wsPath: string): string[] {
  const { active, parked } = new WorkspaceParserService().scanPipelinesDir(path.join(wsPath, '.rix', 'pipelines'))
  return [...active, ...parked].map((p) => p.branch).filter((b): b is string => b !== null)
}
