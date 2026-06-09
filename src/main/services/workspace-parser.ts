import fs from 'fs'
import path from 'path'
import type { Pipeline, ShippedFeature, FixCycleBreakdown } from '../types/workspace'

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

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
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
    const content = readFileSafe(filePath)
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

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      const filePath = path.join(dirPath, entry)
      const content = readFileSafe(filePath)
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
    const content = readFileSafe(filePath)
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
