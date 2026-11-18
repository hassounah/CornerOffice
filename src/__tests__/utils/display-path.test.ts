import { describe, expect, it } from 'vitest'
import { homeRelative, inferHomeDir } from '../../renderer/utils/display-path'
import { LAST_PARENT_KEY, readLastParent, rememberLastParent } from '../../renderer/utils/workspace-prefs'

describe('homeRelative', () => {
  it.each([
    ['/home/amer/projects/api', '~/projects/api'],
    ['/Users/amer/projects/api', '~/projects/api'],
    ['/home/amer', '~'],
    ['/srv/api', '/srv/api'],
    ['/homestead/api', '/homestead/api'],
    ['/home/amer-old/x', '~/x'],
  ])('%s -> %s', (input, expected) => {
    expect(homeRelative(input)).toBe(expected)
  })
})

describe('inferHomeDir', () => {
  it('reads the home off the first path under one', () => {
    expect(inferHomeDir(['/srv/api', '/home/amer/projects/api', '/Users/other/x'])).toBe('/home/amer')
  })

  it('null when no path is under a home', () => {
    expect(inferHomeDir(['/srv/api', '/opt/x'])).toBeNull()
    expect(inferHomeDir([])).toBeNull()
  })
})

describe('workspace prefs', () => {
  it('round-trips the last parent', () => {
    window.localStorage.clear()
    expect(readLastParent()).toBeNull()
    rememberLastParent('/home/amer/code')
    expect(readLastParent()).toBe('/home/amer/code')
    expect(window.localStorage.getItem(LAST_PARENT_KEY)).toBe('/home/amer/code')
  })
})
