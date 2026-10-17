import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../../main/services/app-home'
import type { Profile } from '../../main/services/app-home'

/**
 * Install the active profile for a test that fakes the home directory (#0038). Services read their
 * paths through `coHome()` / `claudeHome()`, which only avoid the real `resolveRealHome()` once a
 * profile is set. `name` omitted selects the default profile; `sandbox` selects sandbox mode (needs a name).
 */
export function useProfile(realHome: string, name?: string, sandbox = false): Profile {
  resetActiveProfileForTests()
  const profile = resolveProfile({ ...(name ? { CORNER_OFFICE_PROFILE: name } : {}), ...(sandbox ? { CORNER_OFFICE_SANDBOX: '1' } : {}) }, { isPackaged: false, realHome, appPath: realHome })
  setActiveProfile(profile)
  return profile
}
