import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// Mock all PNG static imports so Vite doesn't try to resolve them
vi.mock('../../../../../assets/realm/map/Background.png', () => ({ default: '/mock/background.png' }))
vi.mock('../../../../../assets/realm/buildings/Castle.png', () => ({ default: '/mock/castle.png' }))
vi.mock('../../../../../assets/realm/buildings/Barracks.png', () => ({ default: '/mock/barracks.png' }))
vi.mock('../../../../../assets/realm/buildings/Library.png', () => ({ default: '/mock/library.png' }))
vi.mock('../../../../../assets/realm/buildings/Blacksmith.png', () => ({ default: '/mock/blacksmith.png' }))
vi.mock('../../../../../assets/realm/buildings/Farm.png', () => ({ default: '/mock/farm.png' }))
vi.mock('../../../../../assets/realm/buildings/House.png', () => ({ default: '/mock/house.png' }))
vi.mock('../../../../../assets/realm/buildings/Observatory.png', () => ({ default: '/mock/observatory.png' }))
vi.mock('../../../../../assets/realm/buildings/Stables.png', () => ({ default: '/mock/stables.png' }))
vi.mock('../../../../../assets/realm/buildings/Chapel.png', () => ({ default: '/mock/chapel.png' }))
vi.mock('../../../../../assets/realm/buildings/Cottage.png', () => ({ default: '/mock/cottage.png' }))
vi.mock('../../../../../assets/realm/buildings/Tower.png', () => ({ default: '/mock/tower.png' }))
vi.mock('../../../../../assets/realm/buildings/Bell_Tower.png', () => ({ default: '/mock/bell_tower.png' }))
vi.mock('../../../../../assets/realm/buildings/Keep.png', () => ({ default: '/mock/keep.png' }))
vi.mock('../../../../../assets/realm/buildings/Tavern.png', () => ({ default: '/mock/tavern.png' }))
vi.mock('../../../../../assets/realm/buildings/Market_Square.png', () => ({ default: '/mock/market_square.png' }))
vi.mock('../../../../../assets/realm/buildings/House_1.png', () => ({ default: '/mock/house_1.png' }))
vi.mock('../../../../../assets/realm/buildings/House_2.png', () => ({ default: '/mock/house_2.png' }))
vi.mock('../../../../../assets/realm/buildings/House_3.png', () => ({ default: '/mock/house_3.png' }))
vi.mock('../../../../../assets/realm/buildings/House_4.png', () => ({ default: '/mock/house_4.png' }))
vi.mock('../../../../../assets/realm/ui/Lantern_Lit.png', () => ({ default: '/mock/lantern_lit.png' }))
vi.mock('../../../../../assets/realm/ui/Lantern_Unlit.png', () => ({ default: '/mock/lantern_unlit.png' }))
vi.mock('../../../../../assets/realm/homunculus/homunculus_background.png', () => ({ default: '/mock/hom_bg.png' }))
vi.mock('../../../../../assets/realm/homunculus/Homunculus_Instinct_High.png', () => ({ default: '/mock/ih.png' }))
vi.mock('../../../../../assets/realm/homunculus/Homunculus_Instinct_Medium.png', () => ({ default: '/mock/im.png' }))
vi.mock('../../../../../assets/realm/homunculus/Homunculus_Instinct_Low.png', () => ({ default: '/mock/il.png' }))
vi.mock('../../../../../assets/realm/homunculus/Homunculus_Medalion_Agent.png', () => ({ default: '/mock/ma.png' }))
vi.mock('../../../../../assets/realm/homunculus/Homunculus_Medalion_Skill.png', () => ({ default: '/mock/ms.png' }))
vi.mock('../../../../../assets/realm/homunculus/Homunculus_Medalion_Command.png', () => ({ default: '/mock/mc.png' }))
vi.mock('../../../../../assets/realm/documents/Notifications_Scroll_Open.png', () => ({ default: '/mock/ns.png' }))

import { RealmAsset } from '../../../renderer/components/realm/shared/RealmAsset'

describe('RealmAsset', () => {
  it('renders an img for a valid building asset', () => {
    render(<RealmAsset id="building:castle" alt="Castle" />)
    const img = screen.getByAltText('Castle')
    expect(img.tagName).toBe('IMG')
  })

  it('sets draggable to false by default', () => {
    render(<RealmAsset id="building:castle" alt="Castle" />)
    expect(screen.getByAltText('Castle')).toHaveAttribute('draggable', 'false')
  })

  it('passes className and style props to img', () => {
    render(<RealmAsset id="building:castle" alt="Castle" className="test-cls" style={{ width: 100 }} />)
    const img = screen.getByAltText('Castle')
    expect(img).toHaveClass('test-cls')
    expect(img).toHaveStyle({ width: '100px' })
  })

  it('passes aria-hidden prop', () => {
    render(<RealmAsset id="building:castle" alt="Castle" aria-hidden="true" />)
    expect(screen.getByAltText('Castle')).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders background fallback div on error for map:background', () => {
    render(<RealmAsset id="map:background" alt="Background" />)
    fireEvent.error(screen.getByAltText('Background'))
    const fallback = screen.getByRole('img')
    expect(fallback.tagName).toBe('DIV')
    expect(fallback).toHaveAttribute('aria-label', 'Background')
  })

  it('renders background fallback div on error for homunculus:background', () => {
    render(<RealmAsset id="homunculus:background" alt="Homunculus BG" />)
    fireEvent.error(screen.getByAltText('Homunculus BG'))
    const fallback = screen.getByRole('img')
    expect(fallback.tagName).toBe('DIV')
  })

  it('renders building placeholder on error', () => {
    render(<RealmAsset id="building:farm" alt="Farm" />)
    fireEvent.error(screen.getByAltText('Farm'))
    const fallback = screen.getByRole('img')
    expect(fallback.tagName).toBe('DIV')
    expect(fallback).toHaveAttribute('aria-label', 'Farm')
  })

  it('returns null for non-building non-background on error', () => {
    const { container } = render(<RealmAsset id="ui:lantern_lit" alt="Lantern" />)
    fireEvent.error(screen.getByAltText('Lantern'))
    expect(container.firstChild).toBeNull()
  })
})
