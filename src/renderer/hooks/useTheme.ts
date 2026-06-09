import { useEffect } from 'react'
import { useSettingsStore } from '../stores/settings-store'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Reads theme from settings store, applies/removes the `.theme-light` class
 * on document.documentElement, and listens for system preference changes
 * when theme is set to "system".
 */
export function useTheme(): void {
  const config = useSettingsStore((s) => s.config)
  const theme = config?.appearance?.theme ?? 'dark'

  useEffect(() => {
    function applyTheme(isDark: boolean): void {
      if (isDark) {
        document.documentElement.classList.remove('theme-light')
      } else {
        document.documentElement.classList.add('theme-light')
      }
    }

    if (theme === 'dark') {
      applyTheme(true)
      return
    }

    if (theme === 'light') {
      applyTheme(false)
      return
    }

    // system
    const mq = window.matchMedia(SYSTEM_DARK_QUERY)
    applyTheme(mq.matches)
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])
}
