import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { runQuitSequence, HARD_EXIT_MS } from '../main/services/quit-sequence'

// ---------------------------------------------------------------------------
// quit-sequence.ts — B-H1: the 10 s hard-exit timer must be armed BEFORE the
// async cleanup starts, so a stalled cleanup step is actually bounded.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
  mockLog.warn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runQuitSequence', () => {
  it('arms the hard-exit timer before the first cleanup step runs', async () => {
    const exit = vi.fn()
    let timersWhenFirstStepRan = -1
    const run = runQuitSequence({
      exit,
      steps: [
        () => {
          timersWhenFirstStepRan = vi.getTimerCount()
        },
      ],
    })
    await run

    expect(timersWhenFirstStepRan).toBe(1)
  })

  it('exits 1 after 10 s when a cleanup step stalls', async () => {
    const exit = vi.fn()
    void runQuitSequence({ exit, steps: [() => new Promise<void>(() => {})] })

    await vi.advanceTimersByTimeAsync(HARD_EXIT_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('runs the steps in order, then exits 0 and cancels the hard-exit timer', async () => {
    const exit = vi.fn()
    const order: number[] = []

    await runQuitSequence({ exit, steps: [() => void order.push(1), async () => void order.push(2)] })

    expect(order).toEqual([1, 2])
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(HARD_EXIT_MS)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('a failing step is logged and does not skip the rest', async () => {
    const exit = vi.fn()
    const after = vi.fn()

    await runQuitSequence({
      exit,
      steps: [
        () => {
          throw new Error('boom')
        },
        after,
      ],
    })

    expect(after).toHaveBeenCalled()
    expect(mockLog.warn).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('honours a custom hard-exit budget', async () => {
    const exit = vi.fn()
    void runQuitSequence({ exit, hardExitMs: 50, steps: [() => new Promise<void>(() => {})] })

    await vi.advanceTimersByTimeAsync(50)

    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})
