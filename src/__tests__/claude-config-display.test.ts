import { describe, it, expect, afterEach } from 'vitest'
import { claudeConfigDetail } from '../main/types/claude-config'
import { resetActiveProfileForTests } from '../main/services/app-home'
import { useProfile } from './helpers/profile'

// The display strings in the fixed config-failure copy follow the profile (#0038 1.5), except the
// Claude home, which is the real mount source and never does.

describe('claudeConfigDetail display names', () => {
  afterEach(() => resetActiveProfileForTests())

  it('default profile keeps the historical strings', () => {
    useProfile('/home/test')
    expect(claudeConfigDetail('sandbox-state', 'wrong-type')).toContain("The sandbox's state folder in ~/.corner-office/sandbox")
    expect(claudeConfigDetail('settings.json', 'invalid-json')).toContain('~/.claude/settings.json')
  })

  it('a named profile points the state folder at the profile home but keeps ~/.claude', () => {
    useProfile('/home/test', 'dev')
    expect(claudeConfigDetail('sandbox-state', 'wrong-type')).toContain("The sandbox's state folder in ~/.corner-office/profiles/dev/sandbox")
    expect(claudeConfigDetail('settings.json', 'invalid-json')).toContain('~/.claude/settings.json')
  })
})
