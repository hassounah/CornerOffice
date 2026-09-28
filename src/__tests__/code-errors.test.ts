import { describe, it, expect } from 'vitest'
import { friendlyCodeError } from '../renderer/utils/code-errors'

describe('friendlyCodeError', () => {
  it('returns message for PERMISSION_DENIED', () => {
    expect(friendlyCodeError({ code: 'PERMISSION_DENIED' })).toBe("This file can't be accessed")
  })

  it('returns message for NOT_FOUND', () => {
    expect(friendlyCodeError({ code: 'NOT_FOUND' })).toBe('File not found')
  })

  it('returns custom message for VALIDATION_ERROR with message', () => {
    expect(friendlyCodeError({ code: 'VALIDATION_ERROR', message: 'Bad path' })).toBe('Bad path')
  })

  it('returns default message for VALIDATION_ERROR without message', () => {
    expect(friendlyCodeError({ code: 'VALIDATION_ERROR' })).toBe('Invalid request')
  })

  it('returns message for TIMEOUT', () => {
    expect(friendlyCodeError({ code: 'TIMEOUT' })).toBe('Git took too long — try ⟳')
  })

  it('returns message for STALE_WRITE', () => {
    expect(friendlyCodeError({ code: 'STALE_WRITE' })).toBe(
      'File changed on disk — click Reload to see the latest version'
    )
  })

  it('returns fallback for unknown code', () => {
    expect(friendlyCodeError({ code: 'UNKNOWN' })).toBe('Something went wrong')
  })

  it('returns fallback for INTERNAL_ERROR', () => {
    expect(friendlyCodeError({ code: 'INTERNAL_ERROR' })).toBe('Something went wrong')
  })

  it('returns fallback for null input', () => {
    expect(friendlyCodeError(null)).toBe('Something went wrong')
  })

  it('returns fallback for undefined input', () => {
    expect(friendlyCodeError(undefined)).toBe('Something went wrong')
  })
})
