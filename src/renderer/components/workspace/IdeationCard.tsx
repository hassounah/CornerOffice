import React from 'react'
import type { IdeationItem } from '@main/types/workspace'
import { RelativeTime } from '../shared/RelativeTime'

interface IdeationCardProps {
  item: IdeationItem
  onClick?: (item: IdeationItem) => void
}

export function IdeationCard({ item, onClick }: IdeationCardProps): React.ReactElement {
  const handleClick = () => onClick?.(item)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.(item)
    }
  }

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={`Ideation: ${item.title}`}
      onClick={onClick ? handleClick : undefined}
      onKeyDown={onClick ? handleKeyDown : undefined}
      className={[
        'co-card p-3 flex flex-col gap-1.5',
        onClick ? 'cursor-pointer hover:border-co-accent/30 transition-colors' : '',
      ].join(' ')}
    >
      <p className="text-[12px] font-medium text-co-text-primary leading-snug">{item.title}</p>
      <p className="text-[10px] text-co-text-muted/60">
        <RelativeTime timestamp={item.lastModified} />
      </p>
    </div>
  )
}
