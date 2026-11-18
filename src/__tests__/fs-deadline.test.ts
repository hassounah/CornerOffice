import { describe, it, expect, vi, afterEach } from 'vitest'
import { withDeadline, DeadlineError, TIMEOUT_CODE, TIMEOUT_MESSAGE } from '@main/services/fs-deadline'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the value when the promise settles before the deadline', async () => {
    await expect(withDeadline(Promise.resolve(42), 1000)).resolves.toBe(42)
  })

  it('rejects with a TIMEOUT error and the fixed path-free message for a never-resolving promise', async () => {
    vi.useFakeTimers()
    const d = deferred<string>()
    const result = withDeadline(d.promise, 50)
    const assertion = expect(result).rejects.toMatchObject({ code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    await expect(result).rejects.toBeInstanceOf(DeadlineError)
    expect(TIMEOUT_MESSAGE).toBe('Timed out')
    expect(TIMEOUT_CODE).toBe('TIMEOUT')
  })

  it('leaves no timer behind after resolving or rejecting', async () => {
    vi.useFakeTimers()
    await withDeadline(Promise.resolve(1), 1000)
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes an inner rejection through unchanged', async () => {
    const err = Object.assign(new Error('ENOENT: /secret/path'), { code: 'ENOENT' })
    await expect(withDeadline(Promise.reject(err), 1000)).rejects.toBe(err)
  })

  it('does not call onOrphan when the promise settles in time', async () => {
    const onOrphan = vi.fn()
    await withDeadline(Promise.resolve('ok'), 1000, { onOrphan })
    expect(onOrphan).not.toHaveBeenCalled()
  })

  it('fires onOrphan once with the pending promise, and its later settle is observable', async () => {
    vi.useFakeTimers()
    const d = deferred<string>()
    const orphans: Promise<unknown>[] = []
    const onOrphan = vi.fn((p: Promise<unknown>) => {
      orphans.push(p)
    })
    const result = withDeadline(d.promise, 50, { onOrphan })
    const assertion = expect(result).rejects.toMatchObject({ code: TIMEOUT_CODE })
    await vi.advanceTimersByTimeAsync(50)
    await assertion

    expect(onOrphan).toHaveBeenCalledTimes(1)
    expect(orphans[0]).toBe(d.promise)

    d.resolve('late')
    await expect(orphans[0]).resolves.toBe('late')
    expect(onOrphan).toHaveBeenCalledTimes(1)
  })

  it('swallows a late rejection of the orphan (no unhandled rejection) while keeping it observable', async () => {
    vi.useFakeTimers()
    const d = deferred<string>()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const result = withDeadline(d.promise, 10)
      const assertion = expect(result).rejects.toMatchObject({ code: TIMEOUT_CODE })
      await vi.advanceTimersByTimeAsync(10)
      await assertion
      d.reject(new Error('late failure'))
      await expect(d.promise).rejects.toThrow('late failure')
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('ignores a settle that arrives after the timeout already rejected', async () => {
    vi.useFakeTimers()
    const d = deferred<string>()
    const result = withDeadline(d.promise, 5)
    const assertion = expect(result).rejects.toMatchObject({ code: TIMEOUT_CODE })
    await vi.advanceTimersByTimeAsync(5)
    await assertion
    d.resolve('late')
    await vi.advanceTimersByTimeAsync(0)
    await expect(result).rejects.toBeInstanceOf(DeadlineError)
  })
})
