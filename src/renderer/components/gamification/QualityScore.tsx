import React from 'react'

interface QualityScoreProps {
  score: number      // 0-100
  fixCycles?: number // Total fix cycles (shown in tooltip)
}

/**
 * 0-100 quality indicator with color coding:
 * - Green:  80-100
 * - Yellow: 50-79
 * - Red:    0-49
 *
 * Formula: 100 - (totalFixCycles × 10), minimum 0.
 */
export function QualityScore({ score, fixCycles }: QualityScoreProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, Math.round(score)))

  const colorClass =
    clamped >= 80 ? 'text-green-400 bg-green-400/10 border-green-400/30'
    : clamped >= 50 ? 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30'
    : 'text-red-400 bg-red-400/10 border-red-400/30'

  const ringClass =
    clamped >= 80 ? 'stroke-green-400'
    : clamped >= 50 ? 'stroke-yellow-400'
    : 'stroke-red-400'

  const circumference = 2 * Math.PI * 16 // r=16
  const dashOffset = circumference * (1 - clamped / 100)

  const tooltip =
    fixCycles != null
      ? `Quality = 100 - (fix cycles × 10). Fix cycles: ${fixCycles}`
      : 'Quality = 100 - (fix cycles × 10).'

  return (
    <div
      className={`relative inline-flex items-center justify-center rounded-full border ${colorClass} w-14 h-14`}
      title={tooltip}
      aria-label={`Quality score: ${clamped} out of 100`}
      role="img"
    >
      {/* Circular progress ring */}
      <svg
        className="absolute inset-0 w-full h-full -rotate-90"
        viewBox="0 0 40 40"
        aria-hidden="true"
      >
        {/* Background track */}
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className="opacity-10"
        />
        {/* Progress arc */}
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className={ringClass}
        />
      </svg>

      {/* Score number */}
      <span className="text-xs font-bold tabular-nums relative z-10">
        {clamped}
      </span>
    </div>
  )
}
