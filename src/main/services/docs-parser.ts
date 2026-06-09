import fs from 'fs'
import path from 'path'
import type { Feature, IdeationItem } from '../types/workspace'

// Feature directory pattern: "0001-some-feature-name"
const FEATURE_DIR_RE = /^(\d{4})-(.+)$/

function titleCase(str: string): string {
  return str
    .split('-')
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : ''))
    .join(' ')
}

function readDirSafe(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath)
  } catch {
    return []
  }
}

function statSafe(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

export interface DocsRootResult {
  ideationItems: IdeationItem[]
  features: Feature[]
}

export class DocsParserService {
  /**
   * Scan docs_root — aggregates results from TODO/, IN_PROGRESS/, DONE/.
   * All subdirectories handled gracefully if missing.
   */
  scanDocsRoot(docsRootPath: string): DocsRootResult {
    const todoResult = this.scanTodoDir(path.join(docsRootPath, 'TODO'))
    const inProgressFeatures = this.scanInProgressDir(path.join(docsRootPath, 'IN_PROGRESS'))
    const doneFeatures = this.scanDoneDir(path.join(docsRootPath, 'DONE'))

    return {
      ideationItems: todoResult.ideationItems,
      features: [...todoResult.features, ...inProgressFeatures, ...doneFeatures],
    }
  }

  /**
   * Scan TODO/ directory.
   * Plain .md files -> IdeationItem[]
   * Numbered directories (e.g. 0005-feature/) -> Feature[] with status 'todo'
   */
  scanTodoDir(dirPath: string): { ideationItems: IdeationItem[]; features: Feature[] } {
    const entries = readDirSafe(dirPath)
    const ideationItems: IdeationItem[] = []
    const features: Feature[] = []

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry)
      const stat = statSafe(fullPath)
      if (!stat) continue

      if (stat.isDirectory()) {
        const feature = this._parseFeatureDir(fullPath, entry, 'todo')
        if (feature) features.push(feature)
      } else if (stat.isFile() && entry.endsWith('.md')) {
        ideationItems.push({
          filename: entry,
          title: titleCase(entry.replace(/\.md$/, '')),
          lastModified: stat.mtime.toISOString(),
          path: fullPath,
        })
      }
    }

    return { ideationItems, features }
  }

  /**
   * Scan IN_PROGRESS/ directory.
   * Numbered directories -> Feature[] with status 'in_progress'.
   * Plain .md files are ignored (feature sub-artifacts like trd.md, task-list.md).
   */
  scanInProgressDir(dirPath: string): Feature[] {
    const entries = readDirSafe(dirPath)
    const features: Feature[] = []

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry)
      const stat = statSafe(fullPath)
      if (!stat || !stat.isDirectory()) continue

      const feature = this._parseFeatureDir(fullPath, entry, 'in_progress')
      if (feature) features.push(feature)
    }

    return features
  }

  /**
   * Scan DONE/ directory.
   * Numbered directories -> Feature[] with status 'done'.
   * Plain .md files are ignored (legacy features without numbered directories).
   */
  scanDoneDir(dirPath: string): Feature[] {
    const entries = readDirSafe(dirPath)
    const features: Feature[] = []

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry)
      const stat = statSafe(fullPath)
      if (!stat || !stat.isDirectory()) continue

      const feature = this._parseFeatureDir(fullPath, entry, 'done')
      if (feature) features.push(feature)
    }

    return features
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _parseFeatureDir(
    dirPath: string,
    dirName: string,
    status: 'todo' | 'in_progress' | 'done'
  ): Feature | null {
    const match = FEATURE_DIR_RE.exec(dirName)
    if (!match) return null

    const id = match[1]
    const namePart = match[2]
    const name = titleCase(namePart)

    return {
      id,
      name,
      slug: dirName,
      status,
      // These fields are cross-referenced by higher-level orchestration
      pipelineType: null,
      gateProgress: 0,
      isParked: false,
      shippedDate: null,
      directory: dirPath,
    }
  }
}
