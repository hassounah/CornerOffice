import { describe, it, expect, expectTypeOf } from 'vitest'
import { IPC_ERROR_CODES } from '../main/types/ipc'
import type { IpcErrorCode } from '../main/types/ipc'
import type { RequiredCopyCode, WorkspaceErrorCode } from '../renderer/utils/workspace-errors'
import {
  AVAILABILITY_BADGE,
  AVAILABILITY_COPY,
  CHECKING_COPY,
  CONFIG_DIR_MISMATCH_COPY,
  CREATE_WARNING_COPY,
  DOCS_ROOT_REFUSED_COPY,
  LEGACY_NOTICE_COPY,
  NO_DOCS_FOLDER_COPY,
  UNKNOWN_ERROR_COPY,
  WORKSPACE_ERROR_COPY,
  isDamagedStoreHealth,
  isWorkspaceErrorCode,
  storeHealthMessage,
  workspaceErrorMessage,
} from '../renderer/utils/workspace-errors'

// ---------------------------------------------------------------------------
// The copy table (#0039 UX H-8, TRD §3.7, §4.2, §4.5, §4.9): every code has copy, the sentences are verbatim, and an
// unknown code never renders a thrown message.
// ---------------------------------------------------------------------------

const WORKSPACE_CODES = [
  'WORKSPACE_PATH_NOT_FOUND',
  'WORKSPACE_NOT_A_DIRECTORY',
  'WORKSPACE_UNSAFE_ROOT',
  'WORKSPACE_APP_FOLDER',
  'WORKSPACE_DUPLICATE',
  'WORKSPACE_EXISTS',
  'WORKSPACE_NAME_INVALID',
  'WORKSPACE_BUSY_TERMINAL',
  'WORKSPACE_BUSY_SANDBOX',
  'WORKSPACE_LIMIT',
  'DISCOVERY_BUSY',
  'CONFIG_INVALID',
  'CONFIG_WRITE_FAILED',
  'NOT_READY',
  'TIMEOUT',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
] as const

describe('workspaceErrorMessage', () => {
  it.each(WORKSPACE_CODES)('%s has non-empty copy', (code) => {
    expect(isWorkspaceErrorCode(code)).toBe(true)
    expect(workspaceErrorMessage(code).length).toBeGreaterThan(10)
  })

  it('covers every IPC error code main can send, except the four that fall to UNKNOWN on purpose', () => {
    const FALLS_TO_UNKNOWN = ['PERMISSION_DENIED', 'LOCK_TIMEOUT', 'STALE_WRITE', 'SANDBOX_OFF_IN_PROFILE']
    for (const code of Object.values(IPC_ERROR_CODES)) {
      if (FALLS_TO_UNKNOWN.includes(code)) {
        expect(isWorkspaceErrorCode(code), code).toBe(false)
        expect(workspaceErrorMessage(code), code).toBe(UNKNOWN_ERROR_COPY)
      } else {
        expect(isWorkspaceErrorCode(code), code).toBe(true)
      }
    }
    expect(new Set(WORKSPACE_CODES)).toEqual(new Set(Object.keys(WORKSPACE_ERROR_COPY)))
  })

  it('the table\'s keys are exactly the IPC codes that need copy (checked by tsc)', () => {
    expectTypeOf<WorkspaceErrorCode>().toEqualTypeOf<RequiredCopyCode>()
    expectTypeOf<RequiredCopyCode>().toEqualTypeOf<Exclude<IpcErrorCode, 'PERMISSION_DENIED' | 'LOCK_TIMEOUT' | 'STALE_WRITE' | 'SANDBOX_OFF_IN_PROFILE'>>()
  })

  it.each([
    ['WORKSPACE_PATH_NOT_FOUND', "That folder doesn't exist anymore."],
    ['WORKSPACE_NOT_A_DIRECTORY', "That's a file, not a folder."],
    ['WORKSPACE_UNSAFE_ROOT', "Corner Office can't use your home folder or a folder above it. Pick a project folder."],
    ['WORKSPACE_APP_FOLDER', 'That folder holds Corner Office or Claude data. Pick a project folder.'],
    ['WORKSPACE_EXISTS', 'A folder with that name already exists here.'],
    ['WORKSPACE_NAME_INVALID', 'Use letters, numbers, spaces, dots, dashes or underscores (up to 64), starting with a letter or number.'],
    ['WORKSPACE_BUSY_TERMINAL', 'A session is running in this workspace. End it first.'],
    ['WORKSPACE_BUSY_SANDBOX', 'Its sandbox is running. End the sandbox session first.'],
    ['WORKSPACE_LIMIT', "You've reached the limit of 500 workspaces. Remove some first."],
    ['CONFIG_INVALID', 'Corner Office refused to save an invalid change. Nothing was written. Please report this.'],
    ['NOT_READY', 'Corner Office is still starting. Try again in a moment.'],
    ['TIMEOUT', "That folder isn't responding. It may be on a slow or unmounted drive."],
  ])('%s is the verbatim §3.7 sentence', (code, sentence) => {
    expect(workspaceErrorMessage(code)).toBe(sentence)
  })

  it('WORKSPACE_DUPLICATE names the existing workspace, with a fallback', () => {
    expect(workspaceErrorMessage('WORKSPACE_DUPLICATE', { existingName: 'Api' })).toBe('Already added as Api.')
    expect(workspaceErrorMessage('WORKSPACE_DUPLICATE')).toBe('This folder is already in your workspaces.')
    expect(workspaceErrorMessage('WORKSPACE_DUPLICATE', { existingName: '' })).toBe('This folder is already in your workspaces.')
    expect(workspaceErrorMessage('WORKSPACE_DUPLICATE', { existingName: null })).toBe('This folder is already in your workspaces.')
  })

  it('CONFIG_WRITE_FAILED names the config folder', () => {
    expect(workspaceErrorMessage('CONFIG_WRITE_FAILED', { configDirDisplay: '~/.config/corner-office' })).toBe(
      "Couldn't save to ~/.config/corner-office. Check that the folder is writable and the disk isn't full.",
    )
    expect(workspaceErrorMessage('CONFIG_WRITE_FAILED')).toContain('the settings folder')
  })

  it('TIMEOUT reads differently per context', () => {
    expect(workspaceErrorMessage('TIMEOUT', { context: 'add' })).toBe("That folder isn't responding. It may be on a slow or unmounted drive.")
    expect(workspaceErrorMessage('TIMEOUT', { context: 'check' })).toBe('Still not responding.')
  })

  it.each([undefined, null, '', 'SOMETHING_NEW', 'WORKSPACE_MADE_UP', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'an unknown code (%s) gets the fixed UNKNOWN copy',
    (code) => {
      expect(workspaceErrorMessage(code as string | undefined)).toBe(UNKNOWN_ERROR_COPY)
    },
  )

  it('the UNKNOWN copy is the specified sentence and the fallback never renders a thrown message', () => {
    expect(UNKNOWN_ERROR_COPY).toBe('Something went wrong. Nothing was changed.')
    // The function has no parameter that could carry err.message: a stray option is ignored.
    const withMessage = workspaceErrorMessage('NOPE', { message: 'EACCES /home/amer/secret' } as never)
    expect(withMessage).toBe(UNKNOWN_ERROR_COPY)
    expect(withMessage).not.toContain('secret')
  })

  it('INTERNAL_ERROR uses the same generic copy', () => {
    expect(workspaceErrorMessage('INTERNAL_ERROR')).toBe(UNKNOWN_ERROR_COPY)
  })
})

describe('availability copy (§4.5)', () => {
  it('uses the banner sentences verbatim', () => {
    expect(AVAILABILITY_COPY.missing('/mnt/work/api')).toBe(
      'Folder not found: /mnt/work/api. It may be on an unmounted drive. If you moved it, remove it and add the new location. Its name, docs-root setting and sandbox allowlist will be reset.',
    )
    expect(AVAILABILITY_COPY.unreachable('/x')).toBe('Folder not responding. It may be on an unmounted or slow drive.')
    expect(AVAILABILITY_COPY['not-a-directory']('/x')).toBe('This path is now a file, not a folder.')
    expect(AVAILABILITY_COPY.unsafe('/x')).toBe("Corner Office can't use this folder: it is your home folder, a folder above it, or one of the app's own folders.")
    expect(AVAILABILITY_COPY.moved('/x')).toBe(
      'This folder now points somewhere else. If you moved it, remove it and add the new location. Its name, docs-root setting and sandbox allowlist will be reset.',
    )
  })

  it('checking has its own copy', () => {
    expect(CHECKING_COPY).toBe('Checking this folder…')
    expect(AVAILABILITY_COPY.checking('/x')).toBe(CHECKING_COPY)
  })

  it('every non-ok state has a banner sentence and a badge name', () => {
    expect(Object.keys(AVAILABILITY_COPY).sort()).toEqual(['budget', 'checking', 'missing', 'moved', 'not-a-directory', 'unreachable', 'unsafe'])
    expect(Object.keys(AVAILABILITY_BADGE).sort()).toEqual(Object.keys(AVAILABILITY_COPY).sort())
  })

  it('budget does not blame the folder and points to Check again', () => {
    const copy = AVAILABILITY_COPY.budget('/x')
    expect(copy).toBe('Not checked yet: too many folders are still responding slowly. This folder may be fine. Check again in a moment.')
    expect(copy).not.toContain('/x')
    expect(AVAILABILITY_BADGE.budget).toBe('Not checked yet')
  })
})

describe('create warnings (§4.2)', () => {
  it('expands each token with the new folder', () => {
    expect(CREATE_WARNING_COPY['git-unavailable']('/p/new')).toBe("Created. Git wasn't found, so the folder isn't a git repository yet.")
    expect(CREATE_WARNING_COPY['git-init-failed']('/p/new')).toBe('Created, but `git init` failed. Run it yourself in /p/new.')
    expect(CREATE_WARNING_COPY['git-commit-failed']('/p/new')).toBe('Created, but the first commit failed: set `user.name` and `user.email`, then commit in /p/new.')
  })
})

describe('store health (§4.9)', () => {
  it('says what happened and the next step, per store', () => {
    expect(storeHealthMessage('workspaces', 'reset-to-defaults')).toBe(
      "Your workspace list couldn't be read, so it was reset and is empty. Run Discover or Add folder to rebuild it.",
    )
    expect(storeHealthMessage('sandbox', 'reset-to-defaults')).toContain('Re-enter them in the Armory.')
    expect(storeHealthMessage('settings', 'recovered-from-backup')).toContain('restored')
    expect(storeHealthMessage('sessionDefaults', 'recovered-partial')).toContain('Pick them again')
  })

  it('names the real kept file when main has set one aside, and never for an unreadable file', () => {
    expect(storeHealthMessage('workspaces', 'reset-to-defaults', 'workspaces.json.corrupt-20260101T000000Z')).toMatch(
      / The damaged file was kept as workspaces\.json\.corrupt-20260101T000000Z\.$/,
    )
    expect(storeHealthMessage('settings', 'unreadable', 'settings.json.corrupt-20260101T000000Z')).not.toContain('corrupt')
  })

  it('has a sentence for every store and damaged state (unreadable included)', () => {
    for (const store of ['settings', 'workspaces', 'sandbox', 'sessionDefaults'] as const) {
      for (const state of ['recovered-from-backup', 'recovered-partial', 'reset-to-defaults', 'unreadable'] as const) {
        expect(storeHealthMessage(store, state).length).toBeGreaterThan(20)
      }
    }
  })

  it('the upgrade notice and docs-refused copy', () => {
    expect(LEGACY_NOTICE_COPY).toBe(
      "Your earlier workspace list and sandbox settings weren't carried over. Run Discover to find your projects. Sandbox network allowlists, ports and extra packages were reset to safe defaults. Only add back what you still need, in the Armory.",
    )
    expect(DOCS_ROOT_REFUSED_COPY).not.toBe(NO_DOCS_FOLDER_COPY)
  })

  it('the config dir mismatch sentence', () => {
    expect(CONFIG_DIR_MISMATCH_COPY('~/.config/corner-office')).toBe(
      "Settings are saved in ~/.config/corner-office, which differs from Electron's data folder. Check `XDG_CONFIG_HOME`.",
    )
  })

  it('isDamagedStoreHealth separates the four states from ok and absent', () => {
    for (const h of ['recovered-from-backup', 'recovered-partial', 'reset-to-defaults', 'unreadable']) expect(isDamagedStoreHealth(h)).toBe(true)
    for (const h of ['ok', 'absent', 'constructor']) expect(isDamagedStoreHealth(h)).toBe(false)
  })
})
