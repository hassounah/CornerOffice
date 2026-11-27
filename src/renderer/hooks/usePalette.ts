import { useEffect } from 'react'
import { DEFAULT_OFFICE_PALETTE } from '@main/types/appearance'
import { useSettingsStore } from '../stores/settings-store'

/**
 * Reads the office color palette from the settings store and applies it as
 * `data-palette` on document.documentElement (#0040). globals.css restyles the
 * `--co-*` tokens from that attribute, so switching is live with no remount.
 */
export function usePalette(): void {
  const palette = useSettingsStore((s) => s.config?.appearance?.palette ?? DEFAULT_OFFICE_PALETTE)

  useEffect(() => {
    document.documentElement.dataset.palette = palette
  }, [palette])
}
