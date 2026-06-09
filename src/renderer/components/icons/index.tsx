import React from 'react'

// Shared props for all icons
export interface IconProps {
  size?: number
  stroke?: string
  strokeWidth?: number
  className?: string
}

const defaults: Required<Pick<IconProps, 'size' | 'stroke' | 'strokeWidth'>> = {
  size: 24,
  stroke: '#E0E0E0',
  strokeWidth: 1.5,
}

// ─── WORKSPACE STATES ────────────────────────────────────────

export function IconActive({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
      <circle cx="12" cy="12" r="6" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
      <circle cx="12" cy="12" r="2.5" fill="#4ADE80" stroke="none" />
    </svg>
  )
}

export function IconWaiting({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 12a9 9 0 0 0 18 0" fill={stroke} fillOpacity="0.25" stroke="none" />
    </svg>
  )
}

export function IconParked({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="18" height="18" rx="4" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 16V8h3.5a3 3 0 0 1 0 6H9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconIdle({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconAttention({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L22 12L12 22L2 12Z" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="8" x2="12" y2="14" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="0.75" fill={stroke} stroke="none" />
    </svg>
  )
}

// ─── PIPELINE GATES ──────────────────────────────────────────

export function IconGateDesign({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M4 20l1.5-4.5L17.5 3.5a1.5 1.5 0 0 1 2.12 0l0.88 0.88a1.5 1.5 0 0 1 0 2.12L8.5 18.5L4 20z" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <line x1="15" y1="6" x2="18" y2="9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconGatePlan({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <line x1="12" y1="3" x2="12" y2="14" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M12 10C12 10 8 12 6 16" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 10C12 10 16 12 18 16" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="3" r="1.5" fill={stroke} stroke="none" />
      <circle cx="6" cy="17" r="1.5" fill={stroke} stroke="none" />
      <circle cx="18" cy="17" r="1.5" fill={stroke} stroke="none" />
      <circle cx="12" cy="14" r="1.5" fill={stroke} stroke="none" />
    </svg>
  )
}

export function IconGateImplement({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <polyline points="8,7 3,12 8,17" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <line x1="14" y1="5" x2="10" y2="19" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <polyline points="16,7 21,12 16,17" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconGateReview({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 3v4h4" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="15.5" cy="15.5" r="3.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="18" y1="18" x2="21" y2="21" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}

export function IconGatePassed({ size = defaults.size, stroke = '#4ADE80', strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" fill="#4ADE80" fillOpacity="0.15" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="8,12 11,15.5 16.5,9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ─── NAVIGATION ──────────────────────────────────────────────

export function IconDashboard({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="10" height="10" rx="2" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <rect x="16" y="3" width="5" height="5" rx="1.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <rect x="16" y="11" width="5" height="10" rx="1.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <rect x="3" y="16" width="10" height="5" rx="1.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconActivity({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <line x1="8" y1="3" x2="8" y2="21" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.4" />
      <circle cx="8" cy="5" r="2" fill={stroke} stroke="none" />
      <circle cx="8" cy="12" r="2" fill={stroke} stroke="none" />
      <circle cx="8" cy="19" r="2" fill={stroke} stroke="none" />
      <line x1="13" y1="5" x2="20" y2="5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="13" y1="12" x2="18" y2="12" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="13" y1="19" x2="20" y2="19" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}

export function IconInstincts({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 4C10 4 7 5 6 8C5 11 6 13 6 14C6 16 5 17 5 19C5 20.5 7 21 8 20C9 19 9 17 12 17" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 4C14 4 17 5 18 8C19 11 18 13 18 14C18 16 19 17 19 19C19 20.5 17 21 16 20C15 19 15 17 12 17" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="4" x2="12" y2="17" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.4" />
      <path d="M8 9C9.5 9.5 10.5 9 12 9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.5" />
      <path d="M12 9C13.5 9 14.5 9.5 16 9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.5" />
      <path d="M7 13C9 12.5 10.5 13 12 12.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.5" />
      <path d="M12 12.5C13.5 13 15 12.5 17 13" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.5" />
    </svg>
  )
}

export function IconSettings({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="3" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 2l1.5 2.4a1 1 0 0 0 1.2.4L17.5 4l-.1 3a1 1 0 0 0 .7 1l2.9.8-1.7 2.3a1 1 0 0 0 0 1.2l1.7 2.3-2.9.8a1 1 0 0 0-.7 1l.1 3-2.8-.8a1 1 0 0 0-1.2.4L12 22l-1.5-2.4a1 1 0 0 0-1.2-.4L6.5 20l.1-3a1 1 0 0 0-.7-1L3 15.2l1.7-2.3a1 1 0 0 0 0-1.2L3 9.4l2.9-.8a1 1 0 0 0 .7-1L6.5 4l2.8.8a1 1 0 0 0 1.2-.4L12 2z" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ─── SPECIAL ─────────────────────────────────────────────────

export function IconShip({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M13.5 10.5L6 18" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 4c0 0-1.5 0-4.5 3s-4 5.5-4 5.5l3 3c0 0 2.5-1 5.5-4s3-4.5 3-4.5L20 4z" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 13.5L4 15l2.5 2.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 15.5L9 20l2.5-2.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4" cy="20" r="1" fill={stroke} fillOpacity="0.4" stroke="none" />
    </svg>
  )
}

export function IconSeance({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M8 21l1.5-2 1.5 2 1-2 1.5 2 1.5-2V11a4 4 0 0 0-8 0v10l1 -2z" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 11a5 5 0 0 1 10 0" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="11" r="1" fill={stroke} stroke="none" />
      <circle cx="14" cy="11" r="1" fill={stroke} stroke="none" />
    </svg>
  )
}

export function IconParkedPipeline({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <line x1="10" y1="11" x2="10" y2="16" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="14" y1="11" x2="14" y2="16" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}

export function IconInbox({ size = defaults.size, stroke = defaults.stroke, strokeWidth = defaults.strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 7l9 6 9-6" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 2l-2 3h2.5L17 8" stroke="#FBBF24" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
