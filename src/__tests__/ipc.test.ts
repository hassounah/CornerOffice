import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_CHANNELS,
  HOMUNCULUS_CHANNELS,
  GAMIFICATION_CHANNELS,
  ACTIVITY_CHANNELS,
  CONFIG_CHANNELS,
  NOTIFICATION_CHANNELS,
  DOCS_CHANNELS,
  MAIN_CHANNELS,
  PUSH_CHANNELS,
} from '../main/ipc/channels'
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

// ---------------------------------------------------------------------------
// Channel constants
// ---------------------------------------------------------------------------

describe('IPC channel constants', () => {
  it('workspace channels are correct', () => {
    expect(WORKSPACE_CHANNELS.DISCOVER).toBe('workspace:discover')
    expect(WORKSPACE_CHANNELS.GET_ALL).toBe('workspace:getAll')
    expect(WORKSPACE_CHANNELS.GET_DETAIL).toBe('workspace:getDetail')
    expect(WORKSPACE_CHANNELS.UPDATE_CONFIG).toBe('workspace:updateConfig')
    expect(WORKSPACE_CHANNELS.UPDATED).toBe('workspace:updated')
    expect(WORKSPACE_CHANNELS.STATUS_CHANGED).toBe('workspace:statusChanged')
  })

  it('homunculus channels are correct', () => {
    expect(HOMUNCULUS_CHANNELS.GET_STATE).toBe('homunculus:getState')
    expect(HOMUNCULUS_CHANNELS.INSTINCT_ADDED).toBe('homunculus:instinctAdded')
    expect(HOMUNCULUS_CHANNELS.EVOLVED).toBe('homunculus:evolved')
  })

  it('gamification channels are correct', () => {
    expect(GAMIFICATION_CHANNELS.GET_STATE).toBe('gamification:getState')
    expect(GAMIFICATION_CHANNELS.UPDATED).toBe('gamification:updated')
  })

  it('activity channels are correct', () => {
    expect(ACTIVITY_CHANNELS.GET_FEED).toBe('activity:getFeed')
    expect(ACTIVITY_CHANNELS.NEW_ITEM).toBe('activity:newItem')
  })

  it('config channels are correct', () => {
    expect(CONFIG_CHANNELS.GET).toBe('config:get')
    expect(CONFIG_CHANNELS.UPDATE).toBe('config:update')
  })

  it('notification channels are correct', () => {
    expect(NOTIFICATION_CHANNELS.GET_HISTORY).toBe('notifications:getHistory')
    expect(NOTIFICATION_CHANNELS.DISMISS).toBe('notifications:dismiss')
    expect(NOTIFICATION_CHANNELS.NEW).toBe('notification:new')
  })

  it('push channels list has exactly 16 entries', () => {
    expect(PUSH_CHANNELS).toHaveLength(16)
  })

  it('push channels includes feature:shipped', () => {
    expect(PUSH_CHANNELS).toContain('feature:shipped')
  })

  it('push channels includes main:ready', () => {
    expect(PUSH_CHANNELS).toContain(MAIN_CHANNELS.READY)
  })

  it('all push channels are unique', () => {
    expect(new Set(PUSH_CHANNELS).size).toBe(PUSH_CHANNELS.length)
  })
})

// ---------------------------------------------------------------------------
// Zod schemas — validation
// ---------------------------------------------------------------------------

describe('WorkspaceGetDetailSchema', () => {
  it('accepts valid slug', () => {
    expect(WorkspaceGetDetailSchema.safeParse({ slug: 'my-project' }).success).toBe(true)
  })

  it('rejects empty slug', () => {
    expect(WorkspaceGetDetailSchema.safeParse({ slug: '' }).success).toBe(false)
  })

  it('rejects slug over 100 chars', () => {
    expect(WorkspaceGetDetailSchema.safeParse({ slug: 'a'.repeat(101) }).success).toBe(false)
  })

  it('rejects missing slug', () => {
    expect(WorkspaceGetDetailSchema.safeParse({}).success).toBe(false)
  })
})

describe('WorkspaceUpdateConfigSchema', () => {
  it('accepts valid config update', () => {
    expect(
      WorkspaceUpdateConfigSchema.safeParse({
        slug: 'my-project',
        config: { slug: 'my-project', displayName: 'My Project', pinned: true, archived: false, docsRoot: null },
      }).success
    ).toBe(true)
  })

  it('rejects empty slug', () => {
    expect(
      WorkspaceUpdateConfigSchema.safeParse({
        slug: '',
        config: { slug: '', displayName: null, pinned: false, archived: false, docsRoot: null },
      }).success
    ).toBe(false)
  })
})

describe('ActivityGetFeedSchema', () => {
  it('accepts valid limit', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 50 }).success).toBe(true)
  })

  it('accepts optional beforeId', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 50, beforeId: 'abc' }).success).toBe(true)
  })

  it('rejects limit 0', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 0 }).success).toBe(false)
  })

  it('rejects limit > 500', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 501 }).success).toBe(false)
  })

  it('rejects non-integer limit', () => {
    expect(ActivityGetFeedSchema.safeParse({ limit: 1.5 }).success).toBe(false)
  })
})

describe('ConfigUpdateSchema — allowlist enforcement', () => {
  it('accepts valid companyName update', () => {
    expect(ConfigUpdateSchema.safeParse({ companyName: 'Acme Corp' }).success).toBe(true)
  })

  it('accepts appearance update', () => {
    expect(
      ConfigUpdateSchema.safeParse({
        appearance: { theme: 'dark', compactView: false, shipMomentStyle: 'full' },
      }).success
    ).toBe(true)
  })

  it('rejects unknown field (hooks)', () => {
    const result = ConfigUpdateSchema.safeParse({ hooks: { installed: true } })
    // Zod strips unknown fields by default; verify hooks is not in the schema shape
    expect(result.success).toBe(true) // parses OK but strips hooks
    const data = result.data as Record<string, unknown>
    expect(data.hooks).toBeUndefined()
  })

  it('rejects invalid discovery exclusion with path separator', () => {
    const result = ConfigUpdateSchema.safeParse({
      discoveryExclusions: ['../evil'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects discovery exclusion with shell metacharacter', () => {
    expect(ConfigUpdateSchema.safeParse({ discoveryExclusions: ['foo;rm -rf /'] }).success).toBe(false)
  })

  it('accepts valid discovery exclusion', () => {
    expect(ConfigUpdateSchema.safeParse({ discoveryExclusions: ['node_modules', '.git', 'dist'] }).success).toBe(true)
  })

  it('rejects invalid theme value', () => {
    expect(
      ConfigUpdateSchema.safeParse({ appearance: { theme: 'purple', compactView: false, shipMomentStyle: 'full' } }).success
    ).toBe(false)
  })
})

describe('NotificationDismissSchema', () => {
  it('accepts valid UUID', () => {
    expect(NotificationDismissSchema.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true)
  })

  it('rejects non-UUID id', () => {
    expect(NotificationDismissSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
  })

  it('rejects missing id', () => {
    expect(NotificationDismissSchema.safeParse({}).success).toBe(false)
  })
})

describe('NotificationGetHistorySchema', () => {
  it('accepts valid limit', () => {
    expect(NotificationGetHistorySchema.safeParse({ limit: 100 }).success).toBe(true)
  })

  it('rejects limit > 1000', () => {
    expect(NotificationGetHistorySchema.safeParse({ limit: 1001 }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Docs channels + schemas (Step 28)
// ---------------------------------------------------------------------------

describe('DOCS_CHANNELS', () => {
  it('has correct channel values', () => {
    expect(DOCS_CHANNELS.LIST_TREE).toBe('docs:listTree')
    expect(DOCS_CHANNELS.READ_FILE).toBe('docs:readFile')
  })
})

describe('DocsListTreeSchema', () => {
  it('accepts valid input with workspaceSlug', () => {
    expect(
      DocsListTreeSchema.safeParse({ dirPath: '/home/user/docs', workspaceSlug: 'my-project' }).success
    ).toBe(true)
  })

  it('rejects empty dirPath', () => {
    expect(
      DocsListTreeSchema.safeParse({ dirPath: '', workspaceSlug: 'my-project' }).success
    ).toBe(false)
  })

  it('rejects dirPath over 4096 chars', () => {
    expect(
      DocsListTreeSchema.safeParse({ dirPath: 'a'.repeat(4097), workspaceSlug: 'my-project' }).success
    ).toBe(false)
  })

  it('rejects empty workspaceSlug', () => {
    expect(
      DocsListTreeSchema.safeParse({ dirPath: '/some/path', workspaceSlug: '' }).success
    ).toBe(false)
  })

  it('rejects workspaceSlug over 256 chars', () => {
    expect(
      DocsListTreeSchema.safeParse({ dirPath: '/some/path', workspaceSlug: 'a'.repeat(257) }).success
    ).toBe(false)
  })

  it('rejects missing workspaceSlug', () => {
    expect(
      DocsListTreeSchema.safeParse({ dirPath: '/some/path' }).success
    ).toBe(false)
  })
})

describe('DocsReadFileSchema', () => {
  it('accepts valid input', () => {
    expect(
      DocsReadFileSchema.safeParse({ filePath: '/home/user/docs/readme.md', workspaceSlug: 'my-project' }).success
    ).toBe(true)
  })

  it('rejects empty filePath', () => {
    expect(
      DocsReadFileSchema.safeParse({ filePath: '', workspaceSlug: 'my-project' }).success
    ).toBe(false)
  })

  it('rejects filePath over 4096 chars', () => {
    expect(
      DocsReadFileSchema.safeParse({ filePath: 'a'.repeat(4097), workspaceSlug: 'my-project' }).success
    ).toBe(false)
  })

  it('rejects missing filePath', () => {
    expect(
      DocsReadFileSchema.safeParse({ workspaceSlug: 'my-project' }).success
    ).toBe(false)
  })
})

