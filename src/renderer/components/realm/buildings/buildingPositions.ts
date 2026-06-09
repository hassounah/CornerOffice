import type { RealmLocation, ReservedLocation } from '@main/types/config'

export interface BuildingPosition {
  left: number   // percentage of map container width
  top: number    // percentage of map container height
  width: number  // percentage of map container width (sized to match 2560×1440 canvas)
  height: number // percentage of map container height (sized to match 2560×1440 canvas)
}

// ---------------------------------------------------------------------------
// Interactive building positions
// Coordinates tuned for Background.png (2560×1440).
// Width/height derived from actual asset dimensions as % of canvas:
//   Tower 427×362, Castle 417×395, Farm 379×319, Observatory 250×200,
//   Barracks/Bell_Tower/Keep/Library/Stables/Tavern/Market_Square/Chapel 204×204,
//   Blacksmith 175×175, House/Merchant 125×125, Cottage 100×100
// ---------------------------------------------------------------------------

export const interactiveBuildingPositions: Record<RealmLocation | ReservedLocation, BuildingPosition> = {
  // --- Reserved locations ---
  tower:        { left:  3, top:  5, width: 16.68, height: 25.14 },  // 427×362
  bell_tower:   { left: 65, top: 28, width:  7.97, height: 14.17 },  // 204×204
  keep:         { left: 73, top:  3, width:  7.97, height: 14.17 },  // 204×204
  tavern:       { left: 52, top: 23, width:  7.97, height: 14.17 },  // 204×204
  market_square:{ left: 59, top: 18, width:  7.97, height: 14.17 },  // 204×204

  // --- RealmLocations (workspace-assignable) ---
  castle:       { left: 80, top:  2, width: 16.29, height: 27.43 },  // 417×395
  barracks:     { left: 66, top: 15, width:  7.97, height: 14.17 },  // 204×204
  library:      { left: 18, top: 38, width:  7.97, height: 14.17 },  // 204×204
  blacksmith:   { left: 55, top: 50, width:  6.84, height: 12.15 },  // 175×175
  farm:         { left:  6, top: 66, width: 14.80, height: 22.15 },  // 379×319
  merchant_house:{ left: 28, top: 44, width:  4.88, height:  8.68 },  // 125×125
  observatory:  { left:  30, top: 3, width:  9.77, height: 13.89 },  // 250×200
  stables:      { left: 85, top: 55, width:  7.97, height: 14.17 },  // 204×204
  chapel:       { left:  2, top: 42, width:  7.23, height: 12.85 },  // 185×185
  cottage:      { left: 52, top: 72, width:  3.91, height:  6.94 },  // 100×100
}

// ---------------------------------------------------------------------------
// Ambient decorative positions (houses, not interactive)
// ---------------------------------------------------------------------------

export type AmbientLocation = 'house_1' | 'house_2' | 'house_3' | 'house_4'

export const ambientPositions: Record<AmbientLocation, BuildingPosition> = {
  house_1: { left: 35, top: 55, width: 4.88, height: 8.68 },  // 125×125
  house_2: { left: 31, top: 35, width: 4.88, height: 8.68 },  // 125×125
  house_3: { left: 9, top: 44, width: 4.88, height: 8.68 },  // 125×125
  house_4: { left: 26, top: 58, width: 4.88, height: 8.68 },  // 125×125
}

// ---------------------------------------------------------------------------
// Character offset relative to building position (fixed px, not %)
// Characters stack horizontally within the building sprite bounds
// ---------------------------------------------------------------------------

export const CHARACTER_OFFSET_PX = { left: 4, top: 4, spacing: 36 }  // pixels
