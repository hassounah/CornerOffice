import type { TeamLevelName } from './workspace'

export interface GamificationState {
  velocity: VelocityData;
  streak: StreakData;
  workspaceLevels: Record<string, WorkspaceLevelEntry>;  // keyed by workspace slug
}

export interface VelocityData {
  current: number;                 // Rolling 7-day weighted count
  sparkline: number[];             // 28 daily data points (4 weeks)
  trend: 'up' | 'down' | 'flat';
}

export interface StreakData {
  currentDays: number;
  lastShipDate: string | null;     // ISO date
}

export interface WorkspaceLevelEntry {
  xp: number;
  level: number;
}

// Velocity weights by pipeline type
export const VELOCITY_WEIGHTS = {
  direct: 1,
  light: 3,
  full: 10,
} as const;

// XP per feature:
//   Base XP = VELOCITY_WEIGHTS[pipelineType] * 100
//   Quality multiplier = max(0.5, 1 - (totalFixCycles * 0.1))
//   Final XP = floor(Base XP * Quality multiplier)

// All 11 level thresholds (levels 6-9: Traction, Product-Market Fit, Scaling Up, Compounding)
export const LEVEL_THRESHOLDS: Array<{ level: number; name: TeamLevelName; xp: number }> = [
  { level: 1,  name: 'Prototype',          xp: 0 },
  { level: 2,  name: 'Alpha',              xp: 500 },
  { level: 3,  name: 'Beta',               xp: 1500 },
  { level: 4,  name: 'Launched',           xp: 4000 },
  { level: 5,  name: 'Growing',            xp: 8000 },
  { level: 6,  name: 'Traction',           xp: 12000 },
  { level: 7,  name: 'Product-Market Fit', xp: 16000 },
  { level: 8,  name: 'Scaling Up',         xp: 20000 },
  { level: 9,  name: 'Compounding',        xp: 22500 },
  { level: 10, name: 'Scaling',            xp: 25000 },
  { level: 20, name: 'Dominating',         xp: 100000 },
] as const;

// Notification item type (used across notification-related types)
export interface NotificationItem {
  id: string;                      // UUID
  tier: 'requiresAction' | 'idle' | 'progress' | 'activity';
  workspace: string;               // Workspace slug
  title: string;
  body: string;
  timestamp: string;               // ISO 8601
  dismissed: boolean;
  actionLabel: string | null;
}
