import { describe, it, expect } from 'vitest'
import {
  TerminalSpawnShellSchema,
  TerminalWriteSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalGetScrollbackSchema,
  ConfigUpdateSchema,
} from '../main/ipc/schemas'

// ---------------------------------------------------------------------------
// Terminal IPC schema tests — focus on shellSessionKey union
// ---------------------------------------------------------------------------

describe('TerminalSpawnShellSchema', () => {
  it('accepts house_1 through house_4', () => {
    for (const houseId of ['house_1', 'house_2', 'house_3', 'house_4']) {
      const result = TerminalSpawnShellSchema.safeParse({ houseId, cols: 80, rows: 24 })
      expect(result.success, `Expected success for houseId=${houseId}`).toBe(true)
    }
  })

  it('accepts office_shell', () => {
    const result = TerminalSpawnShellSchema.safeParse({ houseId: 'office_shell', cols: 80, rows: 24 })
    expect(result.success).toBe(true)
  })

  it('rejects invalid houseId values', () => {
    for (const houseId of ['house_5', 'house_0', 'office', '', 'shell:house_1']) {
      const result = TerminalSpawnShellSchema.safeParse({ houseId, cols: 80, rows: 24 })
      expect(result.success, `Expected failure for houseId=${houseId}`).toBe(false)
    }
  })
})

describe('terminalSessionKey (used by Write/Resize/Kill/GetScrollback schemas)', () => {
  // terminalSessionKey = terminalSlug | shellSessionKey
  // shellSessionKey regex: /^shell:(house_[1-4]|office_shell)$/

  it('TerminalWriteSchema accepts workspace slugs', () => {
    const result = TerminalWriteSchema.safeParse({ workspaceSlug: 'my-project', data: 'hello' })
    expect(result.success).toBe(true)
  })

  it('TerminalWriteSchema accepts shell:house_1 through shell:house_4', () => {
    for (const key of ['shell:house_1', 'shell:house_2', 'shell:house_3', 'shell:house_4']) {
      const result = TerminalWriteSchema.safeParse({ workspaceSlug: key, data: 'hello' })
      expect(result.success, `Expected success for key=${key}`).toBe(true)
    }
  })

  it('TerminalWriteSchema accepts shell:office_shell', () => {
    const result = TerminalWriteSchema.safeParse({ workspaceSlug: 'shell:office_shell', data: 'hello' })
    expect(result.success).toBe(true)
  })

  it('TerminalWriteSchema rejects invalid session keys', () => {
    for (const key of ['shell:house_5', 'shell:office', 'shell:', ':office_shell']) {
      const result = TerminalWriteSchema.safeParse({ workspaceSlug: key, data: 'hello' })
      expect(result.success, `Expected failure for key=${key}`).toBe(false)
    }
  })

  it('TerminalResizeSchema accepts shell:office_shell', () => {
    const result = TerminalResizeSchema.safeParse({ workspaceSlug: 'shell:office_shell', cols: 80, rows: 24 })
    expect(result.success).toBe(true)
  })

  it('TerminalKillSchema accepts shell:office_shell', () => {
    const result = TerminalKillSchema.safeParse({ workspaceSlug: 'shell:office_shell' })
    expect(result.success).toBe(true)
  })

  it('TerminalGetScrollbackSchema accepts shell:office_shell', () => {
    const result = TerminalGetScrollbackSchema.safeParse({ workspaceSlug: 'shell:office_shell' })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ConfigUpdateSchema — codeExplorer.treeWidth (#0031)
// ---------------------------------------------------------------------------

describe('ConfigUpdateSchema codeExplorer', () => {
  it('accepts an integer treeWidth within bounds', () => {
    for (const treeWidth of [0, 288, 10000]) {
      expect(ConfigUpdateSchema.safeParse({ codeExplorer: { treeWidth } }).success).toBe(true)
    }
  })

  it('accepts an update without codeExplorer', () => {
    expect(ConfigUpdateSchema.safeParse({ companyName: 'Acme' }).success).toBe(true)
  })

  it('rejects non-integer, negative, oversized and non-numeric widths', () => {
    for (const treeWidth of [1.5, -1, 10001, '300', null, Number.NaN]) {
      const result = ConfigUpdateSchema.safeParse({ codeExplorer: { treeWidth } })
      expect(result.success, `Expected failure for treeWidth=${String(treeWidth)}`).toBe(false)
    }
  })

  it('rejects a codeExplorer object without treeWidth', () => {
    expect(ConfigUpdateSchema.safeParse({ codeExplorer: {} }).success).toBe(false)
  })
})
