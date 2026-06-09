import { describe, it, expect } from 'vitest'
import { friendlyDocError } from '../renderer/utils/doc-errors'

describe('friendlyDocError', () => {
  it('returns message for PERMISSION_DENIED', () => {
    expect(friendlyDocError({ code: 'PERMISSION_DENIED' })).toBe("This file can't be accessed")
  })

  it('returns message for NOT_FOUND', () => {
    expect(friendlyDocError({ code: 'NOT_FOUND' })).toBe('File or directory not found')
  })

  it('returns custom message for VALIDATION_ERROR with message', () => {
    expect(friendlyDocError({ code: 'VALIDATION_ERROR', message: 'Bad path' })).toBe('Bad path')
  })

  it('returns default message for VALIDATION_ERROR without message', () => {
    expect(friendlyDocError({ code: 'VALIDATION_ERROR' })).toBe('Invalid request')
  })

  it('returns message for TIMEOUT', () => {
    expect(friendlyDocError({ code: 'TIMEOUT' })).toBe('Request timed out — try again')
  })

  it('returns fallback for unknown code', () => {
    expect(friendlyDocError({ code: 'UNKNOWN' })).toBe('Something went wrong')
  })

  it('returns fallback for null input', () => {
    expect(friendlyDocError(null)).toBe('Something went wrong')
  })

  it('returns fallback for undefined input', () => {
    expect(friendlyDocError(undefined)).toBe('Something went wrong')
  })
})
