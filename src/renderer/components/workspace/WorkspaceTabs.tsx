import React, { useId, useRef, useState } from 'react'
import { MemoryPanel } from './MemoryPanel'
import { ReadmePanel } from './ReadmePanel'

type TabId = 'board' | 'memory' | 'readme'

const TABS: { id: TabId; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'memory', label: 'Memory' },
  { id: 'readme', label: 'README' },
]

interface WorkspaceTabsProps {
  board: React.ReactNode
  memory: string | null
  readme: string | null
}

export function WorkspaceTabs({ board, memory, readme }: WorkspaceTabsProps): React.ReactElement {
  const uid = useId()
  const [active, setActive] = useState<TabId>('board')
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  function selectTab(index: number): void {
    setActive(TABS[index].id)
    tabRefs.current[index]?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number): void {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      selectTab((index + 1) % TABS.length)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      selectTab((index - 1 + TABS.length) % TABS.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      selectTab(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      selectTab(TABS.length - 1)
    }
  }

  function panelContent(id: TabId): React.ReactNode {
    if (id === 'board') return board
    if (id === 'memory') {
      return memory
        ? <MemoryPanel content={memory} />
        : <p className="text-[13px] text-co-text-muted">No project memory yet.</p>
    }
    return readme
      ? <ReadmePanel content={readme} />
      : <p className="text-[13px] text-co-text-muted">No README found.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Workspace sections" className="flex gap-1 border-b border-white/[0.06]">
        {TABS.map((tab, i) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[i] = el }}
              id={`${uid}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${uid}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, i)}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                selected
                  ? 'text-co-accent border-co-accent'
                  : 'text-co-text-muted border-transparent hover:text-co-text-secondary'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {TABS.map((tab) => (
        <div
          key={tab.id}
          id={`${uid}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${uid}-tab-${tab.id}`}
          tabIndex={0}
          hidden={tab.id !== active}
        >
          {panelContent(tab.id)}
        </div>
      ))}
    </div>
  )
}
