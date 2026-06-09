import React from 'react'

interface GateDotsProps {
  total?: number
  passed: number
  current?: number
}

export function GateDots({ total = 3, passed, current }: GateDotsProps): React.ReactElement {
  return (
    <span className="inline-flex gap-1 items-center" aria-label={`${passed} of ${total} gates passed`}>
      {Array.from({ length: total }, (_, i) => {
        let classes: string
        if (i < passed) {
          classes = 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.4)]'
        } else if (i === current) {
          classes = 'bg-co-accent shadow-[0_0_4px_var(--co-accent-glow)]'
        } else {
          classes = 'bg-white/[0.08]'
        }
        return (
          <span
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${classes}`}
            aria-hidden="true"
          />
        )
      })}
    </span>
  )
}
