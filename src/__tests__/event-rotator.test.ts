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
    mockFs.lstatSync = vi.fn().mockReturnValue({ size: 0 })
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
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB - 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(mockFs.renameSync).not.toHaveBeenCalled()
    })

    it('rotates a file that exceeds 10MB', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      // Should rename ws-a.jsonl -> ws-a.jsonl.1
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        `${EVENTS_DIR}/ws-a.jsonl`,
        `${EVENTS_DIR}/ws-a.jsonl.1`
      )
      // Should create fresh file with 'wx' (H2) — refuses to create through
      // anything already at the path (e.g. a planted symlink) instead of
      // following it.
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        `${EVENTS_DIR}/ws-a.jsonl`,
        '',
        expect.objectContaining({ encoding: 'utf-8', mode: 0o600, flag: 'wx' })
      )
    })

    it('a symlink planted at the rotated path is not followed (wx fails, logged) and the target is untouched', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      // Simulate the TOCTOU: something planted a symlink at the active path
      // between the archive rename and the fresh-file create. With 'wx',
      // writeFileSync refuses (EEXIST) rather than following it.
      mockFs.writeFileSync = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
      })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()

      // The archive rename still happened (the old content is safe in .1)...
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        `${EVENTS_DIR}/ws-a.jsonl`,
        `${EVENTS_DIR}/ws-a.jsonl.1`
      )
      // ...but the planted symlink's target was never written through, and
      // the rotation is not reported as complete.
      expect(callbacks.onRotated).not.toHaveBeenCalled()
      expect(flushFn).not.toHaveBeenCalled()
    })

    it('calls onRotated synchronously after rename', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(callbacks.onRotated).toHaveBeenCalledWith(`${EVENTS_DIR}/ws-a.jsonl`)
    })

    it('calls flush after onRotated', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
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
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
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
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
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
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      // Only ws-a.jsonl should be checked and rotated (not the backups themselves)
      expect(callbacks.onRotated).toHaveBeenCalledTimes(1)
    })

    it('rotates multiple files in one pass', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl', 'ws-b.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(callbacks.onRotated).toHaveBeenCalledTimes(2)
    })

    it('skips a symlinked entry in place of a per-workspace subdirectory (lstat, not stat)', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['linked-ws'])
      // lstat on a symlinked "subdirectory" reports isDirectory() false,
      // even if its target is a real directory (H2) — never followed.
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: 0, isDirectory: () => false })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      // readdirSync is called once for the top-level events dir only — the
      // symlinked entry is never descended into.
      expect(mockFs.readdirSync).toHaveBeenCalledTimes(1)
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })

    it('never rotates a symlinked events file (lstat reports the link size, not the target)', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      // lstat on a symlink reports the link's own (tiny) size, well under
      // the threshold, regardless of how large its target is (H2).
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: 40 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.runNow()
      expect(mockFs.renameSync).not.toHaveBeenCalled()
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })

    it('logs and returns when readdirSync fails for the events dir', () => {
      mockFs.readdirSync = vi.fn().mockImplementation(() => {
        throw new Error('EACCES')
      })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      expect(() => svc.runNow()).not.toThrow()
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })

    it('skips an entry when lstat throws inside the subdirectory scan', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['weird-entry'])
      mockFs.lstatSync = vi.fn().mockImplementation(() => {
        throw new Error('ENOENT')
      })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      expect(() => svc.runNow()).not.toThrow()
      // Only the top-level readdirSync — never descends past the failed lstat.
      expect(mockFs.readdirSync).toHaveBeenCalledTimes(1)
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })

    it('logs and continues when readdirSync fails for a per-workspace subdirectory', () => {
      mockFs.readdirSync = vi.fn().mockImplementation((p: string) => {
        if (p === EVENTS_DIR) return ['ws-a']
        throw new Error('EACCES')
      })
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: 0, isDirectory: () => true })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      expect(() => svc.runNow()).not.toThrow()
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })

    it('logs (does not throw) when lstat fails inside _maybeRotate', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockImplementation(() => {
        throw new Error('ENOENT')
      })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      expect(() => svc.runNow()).not.toThrow()
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })

    it('continues rotating when deleting the oldest backup (.jsonl.4) fails', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.unlinkSync = vi.fn().mockImplementation(() => {
        throw new Error('EACCES')
      })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      expect(() => svc.runNow()).not.toThrow()
      // The failed delete doesn't block the rest of the rotation.
      expect(callbacks.onRotated).toHaveBeenCalledWith(`${EVENTS_DIR}/ws-a.jsonl`)
    })

    it('continues shifting backups when one rename in the chain fails', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      mockFs.existsSync = vi.fn().mockReturnValue(true)
      mockFs.renameSync = vi.fn().mockImplementation((src: string) => {
        if (String(src).endsWith('.jsonl.2')) throw new Error('EACCES')
      })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      expect(() => svc.runNow()).not.toThrow()
      // The active-file archive rename (.jsonl -> .jsonl.1) still succeeds.
      expect(callbacks.onRotated).toHaveBeenCalledWith(`${EVENTS_DIR}/ws-a.jsonl`)
    })

    it('does not call onRotated if rename fails', () => {
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
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
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.start()
      vi.advanceTimersByTime(60_000)
      expect(callbacks.onRotated).toHaveBeenCalled()
    })

    it('is idempotent — second start does not create extra intervals', () => {
      vi.useFakeTimers()
      mockFs.readdirSync = vi.fn().mockReturnValue(['ws-a.jsonl'])
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
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
      mockFs.lstatSync = vi.fn().mockReturnValue({ size: TEN_MB + 1 })
      const callbacks = makeCallbacks()
      const svc = new EventRotatorService(callbacks, flushFn)
      svc.start()
      svc.stop()
      vi.advanceTimersByTime(120_000)
      expect(callbacks.onRotated).not.toHaveBeenCalled()
    })
  })
})
