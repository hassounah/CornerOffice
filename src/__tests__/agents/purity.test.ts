import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const AGENTS_DIR = path.resolve(__dirname, '../../main/agents')
const DESCRIPTOR_FILES = ['types.ts', 'descriptors.ts', ...fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `${e.name}/descriptor.ts`)
  .filter((f) => fs.existsSync(path.join(AGENTS_DIR, f)))]

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2])
}

describe('descriptor purity', () => {
  it('scans at least the types, registry and Claude descriptor', () => {
    expect(DESCRIPTOR_FILES).toEqual(expect.arrayContaining(['types.ts', 'descriptors.ts', 'claude/descriptor.ts']))
  })

  it.each(DESCRIPTOR_FILES)('%s imports only zod, siblings and main/types', (file) => {
    const source = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8')
    for (const spec of specifiers(source)) {
      const resolved = spec.startsWith('.') ? path.resolve(path.dirname(path.join(AGENTS_DIR, file)), spec) : null
      const allowed =
        spec === 'zod' ||
        (resolved !== null &&
          (resolved.startsWith(path.resolve(AGENTS_DIR, '../types') + path.sep) ||
            (resolved.startsWith(AGENTS_DIR + path.sep) && /(^|\/)(types|descriptors?)$/.test(resolved))))
      expect(allowed, `${file} imports ${spec}`).toBe(true)
    }
  })
})
