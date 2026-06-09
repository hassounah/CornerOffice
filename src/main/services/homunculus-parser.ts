import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { z } from 'zod'
import type {
  Instinct,
  Observation,
  EvolvedArtifact,
  EvolvedType,
  HomunculusState,
  HomunculusStats,
  CrossWorkspacePattern,
} from '../types'

// ---------------------------------------------------------------------------
// Zod schemas for validation at parse boundary
// ---------------------------------------------------------------------------

const ObservationSchema = z.object({
  timestamp: z.string(),
  event: z.string(),
  tool: z.string().nullable().optional(),
  session: z.string().optional(),
  raw: z.string().nullable().optional(),
})

// ---------------------------------------------------------------------------
// Frontmatter parser (replaces gray-matter to avoid js-yaml version conflict)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, content: raw }
  const data = (yaml.load(match[1]) as Record<string, unknown>) ?? {}
  return { data, content: match[2] }
}

// ---------------------------------------------------------------------------
// HomunculusParserService
// ---------------------------------------------------------------------------

export class HomunculusParserService {
  /**
   * Parse instincts from personal/ and inherited/ subdirectories.
   * Uses gray-matter for YAML frontmatter. Skips malformed files.
   */
  parseInstincts(dir: string): Instinct[] {
    const instincts: Instinct[] = []

    const categories: Array<{ subdir: string; type: 'personal' | 'inherited' }> = [
      { subdir: 'personal', type: 'personal' },
      { subdir: 'inherited', type: 'inherited' },
    ]

    for (const { subdir, type } of categories) {
      const instinctsDir = path.join(dir, 'instincts', subdir)
      if (!fs.existsSync(instinctsDir)) continue

      let files: string[]
      try {
        files = fs.readdirSync(instinctsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.md'))
      } catch {
        continue
      }

      for (const file of files) {
        const filePath = path.join(instinctsDir, file)
        try {
          const raw = fs.readFileSync(filePath, 'utf-8')
          const parsed = parseFrontmatter(raw)
          const fm = parsed.data as Record<string, unknown>

          instincts.push({
            id: String(fm.id ?? path.basename(file, path.extname(file))),
            trigger: String(fm.trigger ?? ''),
            confidence: typeof fm.confidence === 'number' ? fm.confidence : 0.5,
            domain: String(fm.domain ?? 'general'),
            source: String(fm.source ?? 'unknown'),
            content: parsed.content.trim(),
            filePath,
            lastModified: this._mtime(filePath),
            type,
          })
        } catch (err) {
          log.warn(`[HomunculusParser] Skipping malformed instinct file: ${filePath}`, err)
        }
      }
    }

    return instincts
  }

  /**
   * Tail-read last `limit` lines from observations.jsonl.
   * Never loads the full file into memory — reads from the end.
   */
  parseRecentObservations(filePath: string, limit: number): Observation[] {
    if (!fs.existsSync(filePath)) return []

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return []
    }

    const fileSize = stat.size
    if (fileSize === 0) return []

    // Read backwards in chunks to find the last `limit` lines
    const CHUNK_SIZE = 16 * 1024 // 16KB
    let remaining = fileSize
    let linesFound: string[] = []
    let partial = ''

    while (remaining > 0 && linesFound.length < limit) {
      const readSize = Math.min(CHUNK_SIZE, remaining)
      const position = remaining - readSize
      remaining = position

      let chunk: Buffer
      let fd: number | undefined
      try {
        fd = fs.openSync(filePath, 'r')
        chunk = Buffer.alloc(readSize)
        fs.readSync(fd, chunk, 0, readSize, position)
      } catch {
        break
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
      }

      const text = chunk.toString('utf-8') + partial
      const lines = text.split('\n')
      // First element may be a partial line (no newline at start of chunk)
      partial = lines[0]
      const completeLines = lines.slice(1).reverse()
      linesFound = [...completeLines, ...linesFound]
    }

    // Add any remaining partial line
    if (partial.trim()) linesFound = [partial, ...linesFound]

    const observations: Observation[] = []
    const linesToProcess = linesFound.slice(-limit)

    for (const line of linesToProcess) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const raw = JSON.parse(trimmed) as unknown
        const result = ObservationSchema.safeParse(raw)
        if (result.success) {
          observations.push({
            timestamp: result.data.timestamp,
            event: result.data.event,
            tool: result.data.tool ?? null,
            session: result.data.session ?? '',
            raw: result.data.raw ?? null,
          })
        }
      } catch {
        log.warn(`[HomunculusParser] Skipping malformed observation line`)
      }
    }

    return observations
  }

  /**
   * Scan evolved/agents/, evolved/skills/, evolved/commands/ for artifacts.
   */
  parseEvolvedArtifacts(dir: string): EvolvedArtifact[] {
    const artifacts: EvolvedArtifact[] = []

    const categories: Array<{ subdir: string; type: EvolvedType }> = [
      { subdir: 'agents', type: 'agent' },
      { subdir: 'skills', type: 'skill' },
      { subdir: 'commands', type: 'command' },
    ]

    for (const { subdir, type } of categories) {
      const evolvedDir = path.join(dir, 'evolved', subdir)
      if (!fs.existsSync(evolvedDir)) continue

      let files: string[]
      try {
        files = fs.readdirSync(evolvedDir)
      } catch {
        continue
      }

      for (const file of files) {
        const filePath = path.join(evolvedDir, file)
        try {
          const stat = fs.statSync(filePath)
          if (!stat.isFile()) continue
          const content = fs.readFileSync(filePath, 'utf-8')
          artifacts.push({
            name: path.basename(file, path.extname(file)),
            type,
            filePath,
            lastModified: stat.mtime.toISOString(),
            content: content.slice(0, 500), // preview only
          })
        } catch (err) {
          log.warn(`[HomunculusParser] Skipping evolved artifact: ${filePath}`, err)
        }
      }
    }

    return artifacts
  }

  /**
   * Compute stats from parsed data.
   * Cross-workspace pattern: domain with 2+ instincts.
   */
  computeStats(
    instincts: Instinct[],
    observations: Observation[],
    evolved: EvolvedArtifact[]
  ): HomunculusStats {
    const domainCounts = new Map<string, number>()
    let high = 0, medium = 0, low = 0

    for (const inst of instincts) {
      domainCounts.set(inst.domain, (domainCounts.get(inst.domain) ?? 0) + 1)
      if (inst.confidence >= 0.8) high++
      else if (inst.confidence >= 0.5) medium++
      else low++
    }

    const sortedDomains = [...domainCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([domain]) => domain)
      .slice(0, 5)

    // Cross-workspace patterns: domains with 2+ instincts
    const crossWorkspacePatterns: CrossWorkspacePattern[] = [...domainCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([domain]) => {
        const domainInstincts = instincts.filter((i) => i.domain === domain)
        return {
          instinctId: domainInstincts[0]?.id ?? domain,
          domain,
          confidence: domainInstincts.reduce((sum, i) => sum + i.confidence, 0) / domainInstincts.length,
          workspacesApplied: [],
        }
      })

    return {
      totalInstincts: instincts.length,
      personalCount: instincts.filter((i) => i.type === 'personal').length,
      inheritedCount: instincts.filter((i) => i.type === 'inherited').length,
      evolvedAgents: evolved.filter((e) => e.type === 'agent').length,
      evolvedSkills: evolved.filter((e) => e.type === 'skill').length,
      evolvedCommands: evolved.filter((e) => e.type === 'command').length,
      totalObservations: observations.length,
      confidenceDistribution: { high, medium, low },
      mostActiveDomains: sortedDomains,
      crossWorkspacePatterns,
    }
  }

  /**
   * Build a full HomunculusState from the ~/.claude/homunculus/ directory.
   */
  parseAll(homunculusDir: string, observationLimit = 100): HomunculusState {
    const instincts = this.parseInstincts(homunculusDir)
    const observations = this.parseRecentObservations(
      path.join(homunculusDir, 'observations.jsonl'),
      observationLimit
    )
    const evolved = this.parseEvolvedArtifacts(homunculusDir)
    const stats = this.computeStats(instincts, observations, evolved)

    return { instincts, observations, evolved, stats }
  }

  private _mtime(filePath: string): string {
    try {
      return fs.statSync(filePath).mtime.toISOString()
    } catch {
      return new Date().toISOString()
    }
  }
}

export const homunculusParserService = new HomunculusParserService()
