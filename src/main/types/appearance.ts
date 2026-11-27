// ---------------------------------------------------------------------------
// appearance.ts — office color palette ids (#0040). Pure constants with no
// zod and no fs, so the config store, the IPC schemas and the renderer can
// all import them.
// ---------------------------------------------------------------------------

export const OFFICE_PALETTE_IDS = ['eucalyptus', 'signal', 'moss'] as const
export type OfficePaletteId = (typeof OFFICE_PALETTE_IDS)[number]
export const DEFAULT_OFFICE_PALETTE: OfficePaletteId = 'eucalyptus'
