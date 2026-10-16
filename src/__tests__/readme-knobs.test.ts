import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// README drift guard (#0038, UX M8): every CORNER_OFFICE_* variable read by app-home.ts or
// the dev sandbox launcher must appear in the README's Dev profiles knob table.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../..')
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

describe.each(['src/main/services/app-home.ts', 'scripts/co_dev_sandbox.sh'])('README knob table vs %s', (file) => {
  it('lists every CORNER_OFFICE_* name', () => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const names = [...new Set(source.match(/CORNER_OFFICE_[A-Z_]+/g) ?? [])]
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => !readme.includes(`\`${n}\``))).toEqual([])
  })
})
