import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { wrapHandler, notReadyStub } from '../main/ipc/wrap-handler'

const fakeEvent = {} as Electron.IpcMainInvokeEvent

describe('wrapHandler', () => {
  it('returns data envelope on success', async () => {
    const handler = wrapHandler(async (input: string) => input.toUpperCase())
    const result = await handler(fakeEvent, 'hello')
    expect(result).toEqual({ data: 'HELLO', error: null })
  })

  it('validates input with schema and succeeds', async () => {
    const schema = z.object({ name: z.string() })
    const handler = wrapHandler(async (input: { name: string }) => `Hi ${input.name}`, schema)
    const result = await handler(fakeEvent, { name: 'Alice' })
    expect(result).toEqual({ data: 'Hi Alice', error: null })
  })

  it('returns validation error for invalid input', async () => {
    const schema = z.object({ name: z.string() })
    const handler = wrapHandler(async (input: { name: string }) => input.name, schema)
    const result = await handler(fakeEvent, { name: 123 })
    expect(result.data).toBeNull()
    expect(result.error).not.toBeNull()
    expect(result.error!.code).toBe('VALIDATION_ERROR')
  })

  it('returns error envelope when handler throws', async () => {
    const handler = wrapHandler(async () => { throw new Error('boom') })
    const result = await handler(fakeEvent, undefined)
    expect(result.data).toBeNull()
    expect(result.error!.message).toBe('boom')
  })

  it('uses error code from thrown error if present', async () => {
    const handler = wrapHandler(async () => {
      throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' })
    })
    const result = await handler(fakeEvent, undefined)
    expect(result.error!.code).toBe('PERMISSION_DENIED')
  })
})

describe('notReadyStub', () => {
  it('returns NOT_READY error envelope', async () => {
    const stub = notReadyStub()
    const result = await stub()
    expect(result.data).toBeNull()
    expect(result.error!.code).toBe('NOT_READY')
  })
})
