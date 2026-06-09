import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventRotatorService } from '../main/services/event-rotator'

vi.mock('fs')
vi.mock('os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))

import fs from 'fs'
const mockFs = fs as unknown as Record<string, ReturnType<typeof vi.fn>>

const EVENTS_DIR = '/home/test/.corner-office/events'
const TEN_MB = 10 * 1024 * 1024

function makeCallbacks() {
  return {
    onRotated: vi.fn(),
  }
}

describe('EventRotatorService', () => {
  let flushFn: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.clearAllMocks()
    flushFn = vi.fn<() => void>()
    mockFs.existsSync = vi.fn().mockReturnValue(true)
    mockFs.readdirSync = vi.fn().mockReturnValue([])
    mockFs.statSync = vi.fn().mockReturnValue({ size: 0 })
    mockFs.unlinkSync = vi.fn()
    mockFs.renameSync = vi.fn()
    mockFs.writeFileSync = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('runNow', () => {
    it('does nothing when events directory does not exist', () => {
      mockFs.existsSync = vi.fn().mockReturnValue(false)
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(mockFs.readdirSync).not.toHaveBeenCalled()
    })

    it('does not rotate files under 10MB', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB - 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(mockFs.renameSync).not.toHaveBeenCalled()
    })

    it('rotates a file that exceeds 10MB', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      // Should rename ws-a.jsonl -> ws-a.jsonl.1
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        `${EVENTS_DIR}/ws-a.jsonl`,
        `${EVENTS_DIR}/ws-a.jsonl.1`
      )
      // Should create fresh file
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        `${EVENTS_DIR}/ws-a.jsonl`,
        '',
        expect.objectContaining({ encoding: 'utf-8', mode: 0o600 })
      )
    })

    it('calls onRotated synchronously after rename', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(callbacks.onRotated).toHaveBeenCalledWith(`${EVENTS_DIR}/ws-a.jsonl`)
    })

    it('calls flush after onRotated', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callOrder: string[] = []
      const callbacks = {
        onRotated: vi.fn(() => callOrder.push('onRotated')),
      }
      const flush = vi.fn(() => callOrder.push('flush'))
      const svc = new EventRotatorService(callbacks, flush)
      svc.runNow()
      expect(callOrder).toEqual(['onRotated', 'flush'])
    })

    it('deletes .jsonl.4 before shifting backups', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      // .jsonl.4 exists
      mockFs.existsSync = vi.fn().mockImplementation((p: string) =>
        !String(p).endsWith('.jsonl.4') ? true : true
      )
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(`${EVENTS_DIR}/ws-a.jsonl.4`)
    })

    it('shifts rotation backups .3->.4, .2->.3, .1->.2', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      const renames = (mockFs.renameSync as ReturnType<typeof vi.fn>).mock.calls
      expect(renames).toContainEqual([`${EVENTS_DIR}/ws-a.jsonl.3`, `${EVENTS_DIR}/ws-a.jsonl.4`])
      expect(renames).toContainEqual([`${EVENTS_DIR}/ws-a.jsonl.2`, `${EVENTS_DIR}/ws-a.jsonl.3`])
      expect(renames).toContainEqual([`${EVENTS_DIR}/ws-a.jsonl.1`, `${EVENTS_DIR}/ws-a.jsonl.2`])
    })

    it('skips backup rotation files (.jsonl.1 etc)', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl', 'ws-a.jsonl.1', 'ws-a.jsonl.2'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      // Only ws-a.jsonl should be checked and rotated (not the backups themselves)
      expect(callbacks.onRotated).toHaveBeenCalledTimes(1)
    })

    it('rotates multiple files in one pass', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl', 'ws-b.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(callbacks.onRotated).toHaveBeenCalledTimes(2)
    })

    it('does not call onRotated if rename fails', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      mockFs.renameSync = vi.fn().mockImplementation((src: string) => {
        if (String(src).endsWith('.jsonl')) throw new Error('rename failed')
      })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })
  })

  describe('start / stop', () => {
    it('starts a 60-second interval', () => {
      vi.useFakeTimers()
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.start()
      vi.advanceTimersByTime(60_000)
      expect(callbacks.onRotated).toHaveBeenCalled()
    })

    it('is idempotent — second start does not create extra intervals', () => {
      vi.useFakeTimers()
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.start()
      svc.start()
      vi.advanceTimersByTime(60_000)
      expect(callbacks.onRotated).toHaveBeenCalledTimes(1)
    })

    it('stop cancels the interval', () => {
      vi.useFakeTimers()
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.statSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.start()
      svc.stop()
      vi.advanceTimersByTime(120_000)
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })
  })
})
