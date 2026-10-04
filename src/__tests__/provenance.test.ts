import { describe, it, expect } from 'vitest'
import { isSandboxSource } from '../renderer/utils/provenance'

// SEC-H3: the renderer reads `source` from main and fails closed on anything unexpected.
describe('isSandboxSource', () => {
  it('is false for an absent source and for host (a host item omits the field)', () => {
    expect(isSandboxSource(undefined)).toBe(false)
    expect(isSandboxSource('host')).toBe(false)
  })

  it('is true for sandbox', () => {
    expect(isSandboxSource('sandbox')).toBe(true)
  })

  it.each(['', 'SANDBOX', 'Host', 'unknown', null, 0, false, {}, ['host']])('fails closed (sandbox) for the unexpected value %j', (value) => {
    expect(isSandboxSource(value)).toBe(true)
  })
})
