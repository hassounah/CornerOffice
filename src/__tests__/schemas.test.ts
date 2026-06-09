import { describe, it, expect } from 'vitest'
import {
  WorkspaceGetDetailSchema,
  WorkspaceUpdateConfigSchema,
  ActivityGetFeedSchema,
  ConfigUpdateSchema,
  NotificationDismissSchema,
  NotificationGetHistorySchema,
  DocsListTreeSchema,
  DocsReadFileSchema,
} from '../main/ipc/schemas'

describe('WorkspaceGetDetailSchema', () => {
  it('accepts valid slug', () => {
    expect(WorkspaceGetDetailSchema.safeParse({ slug: 'my-project' }).success).toBe(true)
  })

  it('rejects empty slug', () => {
    expect(WorkspaceGetDetailSchema.safeParse({ slug: '' }).success).toBe(false)
  })
})

describe('WorkspaceUpdateConfigSchema', () => {
  it('accepts full valid input', () => {
    const result = WorkspaceUpdateConfigSchema.safeParse({
      slug: 'ws',
      config: { slug: 'ws', displayName: 'Test', pinned: false, archived: false, docsRoot: null },
    })
    expect(result.success).toBe(true)
  })
})

describe('ActivityGetFeedSchema', () => {
  it('accepts valid input', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 50 }).success).toBe(true)
  })

  it('accepts optional beforeId', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 10, beforeId: 'abc' }).success).toBe(true)
  })

  it('rejects limit of 0', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 0 }).success).toBe(false)
  })
})

describe('ConfigUpdateSchema', () => {
  it('accepts appearance update', () => {
    const result = ConfigUpdateSchema.safeParse({
      appearance: { theme: 'dark', compactView: true, shipMomentStyle: 'compact' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts notification config', () => {
    const result = ConfigUpdateSchema.safeParse({
      notifications: {
        osNotificationsEnabled: true,
        showMissedOnStartup: true,
        tiers: {
          requiresAction: { enabled: true, sound: true },
          idle: { enabled: true, osNotification: false },
          progress: { enabled: true, osNotification: false },
          activity: { enabled: false },
        },
        idleThresholdMinutes: 5,
        quietHours: { enabled: false, start: '22:00', end: '08:00' },
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts discoveryExclusions', () => {
    const result = ConfigUpdateSchema.safeParse({
      discoveryExclusions: ['node_modules', '.git'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid discoveryExclusion with path separator', () => {
    const result = ConfigUpdateSchema.safeParse({
      discoveryExclusions: ['../escape'],
    })
    expect(result.success).toBe(false)
  })

  it('accepts realm config', () => {
    const result = ConfigUpdateSchema.safeParse({
      realm: {
        enabled: true,
        mapping: [{ location: 'castle', workspaceSlug: 'ws-1' }],
        shipCelebration: 'townSquare',
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects duplicate realm locations', () => {
    const result = ConfigUpdateSchema.safeParse({
      realm: {
        enabled: true,
        mapping: [
          { location: 'castle', workspaceSlug: 'ws-1' },
          { location: 'castle', workspaceSlug: 'ws-2' },
        ],
        shipCelebration: 'townSquare',
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts workspace display updates', () => {
    const result = ConfigUpdateSchema.safeParse({
      workspaces: [{ slug: 'ws-1', displayName: 'New Name', pinned: true }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts terminalEmulator', () => {
    const result = ConfigUpdateSchema.safeParse({
      terminalEmulator: 'alacritty',
    })
    expect(result.success).toBe(true)
  })

  it('accepts companyName', () => {
    const result = ConfigUpdateSchema.safeParse({
      companyName: 'Acme Corp',
    })
    expect(result.success).toBe(true)
  })
})

describe('NotificationDismissSchema', () => {
  it('accepts valid UUID', () => {
    expect(NotificationDismissSchema.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true)
  })

  it('rejects non-UUID string', () => {
    expect(NotificationDismissSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('NotificationGetHistorySchema', () => {
  it('accepts valid limit', () => {
    expect(NotificationGetHistorySchema.safeParse({ limit: 100 }).success).toBe(true)
  })
})

describe('DocsListTreeSchema', () => {
  it('accepts valid input', () => {
    expect(DocsListTreeSchema.safeParse({ dirPath: '/docs', workspaceSlug: 'ws' }).success).toBe(true)
  })
})

describe('DocsReadFileSchema', () => {
  it('accepts valid input', () => {
    expect(DocsReadFileSchema.safeParse({ filePath: '/docs/readme.md', workspaceSlug: 'ws' }).success).toBe(true)
  })
})
