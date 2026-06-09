import React, { useId } from 'react'

interface RealmTooltipProps {
  label: string
  children: React.ReactNode
  className?: string
}

export function RealmTooltip({ label, children, className }: RealmTooltipProps): React.ReactElement {
  const tooltipId = useId()

  return (
    <div
      className={`relative group ${className ?? ''}`}
      aria-describedby={tooltipId}
    >
      {children}
      <div
        id={tooltipId}
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity duration-150"
        style={{
          background: 'rgba(30,20,10,0.92)',
          color: '#c9a84c',
          border: '1px solid rgba(201,168,76,0.4)',
          fontFamily: 'serif',
        }}
        role="tooltip"
      >
        {label}
      </div>
    </div>
  )
}
