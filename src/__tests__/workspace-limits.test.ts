import { describe, it, expect } from 'vitest'
import { REGISTRY_MAX } from '../main/services/stores'
import { MAX_WORKSPACES, formatAgo, plural, remainingCapacity } from '../renderer/utils/workspace-limits'

describe('workspace-limits', () => {
  it('the renderer cap equals main\'s REGISTRY_MAX', () => {
    expect(MAX_WORKSPACES).toBe(REGISTRY_MAX)
  })

  it.each([
    [0, 500],
    [3, 497],
    [499, 1],
    [500, 0],
    [501, 0],
  ])('remainingCapacity(%i) = %i', (registered, left) => {
    expect(remainingCapacity(registered)).toBe(left)
  })

  it('plural', () => {
    expect(plural(1, 'folder')).toBe('1 folder')
    expect(plural(0, 'folder')).toBe('0 folders')
    expect(plural(12431, 'folder')).toBe('12,431 folders')
    expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })

  it.each([
    [0, 'just now'],
    [44_000, 'just now'],
    [60_000, '1 min ago'],
    [3 * 60_000, '3 min ago'],
    [59 * 60_000, '59 min ago'],
    [2 * 3_600_000, '2 h ago'],
    [23 * 3_600_000, '23 h ago'],
    [24 * 3_600_000, '1 day ago'],
    [3 * 24 * 3_600_000, '3 days ago'],
  ])('formatAgo(%i ms ago) = %s', (ago, text) => {
    expect(formatAgo(1_000_000 - ago, 1_000_000)).toBe(text)
  })

  it('formatAgo never goes negative for a future timestamp', () => {
    expect(formatAgo(2_000_000, 1_000_000)).toBe('just now')
  })
})
