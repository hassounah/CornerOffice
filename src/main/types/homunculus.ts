export interface Instinct {
  id: string;                      // e.g. "asyncio-baseexception-cleanup"
  trigger: string;                 // Human-readable trigger condition
  confidence: number;              // 0.0 - 1.0
  domain: string;                  // e.g. "python", "claude-code-plugins"
  source: string;                  // e.g. "session-observation"
  content: string;                 // Full markdown body (Problem/Action/Example)
  filePath: string;                // Absolute path to YAML file
  lastModified: string;            // ISO 8601
  type: 'personal' | 'inherited';
}

export interface Observation {
  timestamp: string;               // ISO 8601
  event: string;                   // e.g. "tool_complete", "parse_error"
  tool: string | null;
  session: string;                 // Session UUID
  raw: string | null;              // Raw data for parse_error events
}

export type EvolvedType = 'agent' | 'skill' | 'command';

export interface EvolvedArtifact {
  name: string;                    // Filename without extension
  type: EvolvedType;
  filePath: string;
  lastModified: string;
  content: string;
}

export interface HomunculusState {
  instincts: Instinct[];
  observations: Observation[];     // Recent observations only (last N)
  evolved: EvolvedArtifact[];
  stats: HomunculusStats;
}

export interface HomunculusStats {
  totalInstincts: number;
  personalCount: number;
  inheritedCount: number;
  evolvedAgents: number;
  evolvedSkills: number;
  evolvedCommands: number;
  totalObservations: number;       // Approximate from file line count
  confidenceDistribution: {
    high: number;                  // >= 0.8
    medium: number;                // 0.5 - 0.79
    low: number;                   // < 0.5
  };
  mostActiveDomains: string[];     // Top 5 domains by instinct count
  crossWorkspacePatterns: CrossWorkspacePattern[];
}

export interface CrossWorkspacePattern {
  instinctId: string;
  domain: string;
  confidence: number;
  workspacesApplied: string[];     // Workspace slugs where this pattern fired
}
