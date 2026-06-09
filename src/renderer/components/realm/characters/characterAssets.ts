import type { CharacterRole } from '@main/types/realm'

import builderPng from '../../../../../assets/realm/characters/agents/Builder.png'
import inspectorPng from '../../../../../assets/realm/characters/agents/Inspector.png'
import guardLeftPng from '../../../../../assets/realm/characters/agents/Guard_Left.png'
import guardRightPng from '../../../../../assets/realm/characters/agents/Guard_Right.png'
import blacksmithPng from '../../../../../assets/realm/characters/agents/Blacksmith-1.png'
import wizardPng from '../../../../../assets/realm/characters/agents/Rix_Wizard.png'

export const CHARACTER_ROLE_ASSETS: Record<CharacterRole, string> = {
  builder: builderPng,
  inspector: inspectorPng,
  guard_left: guardLeftPng,
  guard_right: guardRightPng,
  blacksmith: blacksmithPng,
  wizard: wizardPng,
}
