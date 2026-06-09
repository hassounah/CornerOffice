export type WorkspaceStatus = 'active' | 'waiting' | 'parked' | 'idle' | 'attention';

export interface Workspace {
  slug: string;                    // Directory name, e.g. "seraph"
  path: string;                    // Absolute path, e.g. "/home/amer/seraph"
  displayName: string;             // Custom name or slug, title-cased
  docsRoot: string;                // Absolute path to docs_root
  docsRootExists: boolean;         // Whether the docs_root directory exists on disk
  status: WorkspaceStatus;
  nextFeatureId: number | null;
  projectContext: string;          // From memory.md Project Context section
  activePipelines: Pipeline[];
  parkedPipelines: Pipeline[];
  features: Feature[];
  ideationItems: IdeationItem[];
  shippedFeatures: ShippedFeature[];
  lastActivityTimestamp: string | null;  // ISO 8601
  weekShipCount: number;           // Features shipped this calendar week
  pinned: boolean;
  archived: boolean;
  level: TeamLevel;
  xp: number;
  readmeContent: string | null;
}

export interface Pipeline {
  slug: string;                    // Filename stem, e.g. "0017-multi-session-pipelines"
  featureName: string;
  featureId: string | null;        // e.g. "0001", null for unnumbered
  pipelineType: 'direct' | 'light' | 'full';
  stage: string;                   // e.g. "design", "plan", "impl", "impl-review"
  gate: number | null;             // 1, 2, 3 for full pipeline
  branch: string | null;
  planFile: string | null;
  taskList: string | null;
  started: string;                 // ISO date
  fixCycles: number;
  parkedAt: string | null;         // ISO date, set when parked
  lastDecision: string | null;     // Last logged decision before parking
}

export type FeatureStatus = 'todo' | 'in_progress' | 'done';

export interface Feature {
  id: string;                      // e.g. "0001"
  name: string;                    // De-slugified from directory name
  slug: string;                    // e.g. "0001-cron-timezone"
  status: FeatureStatus;
  pipelineType: 'direct' | 'light' | 'full' | null;
  gateProgress: number;            // 0-3, gates passed
  isParked: boolean;
  shippedDate: string | null;      // ISO date
  directory: string;               // Absolute path to feature directory
}

export interface IdeationItem {
  filename: string;                // e.g. "webhook-hmac-auth-prd.md"
  title: string;                   // Derived from filename, de-slugified
  lastModified: string;            // ISO 8601
  path: string;                    // Absolute path
}

export interface ShippedFeature {
  id: string | null;               // Feature ID if assigned
  name: string;
  shippedDate: string;             // ISO date
  pipelineType: 'direct' | 'light' | 'full';
  gatesPassed: string;             // e.g. "3/3 passed"
  fixCycles: FixCycleBreakdown;
  filesChanged: string;            // Raw text from history.md
  testsInfo: string | null;        // e.g. "972 passing (37 new)"
  mode: string | null;             // e.g. "full-team (4 agents)"
  keyComponents: string | null;    // Raw text from history.md
  qualityScore: number;            // Derived: 100 - (totalFixCycles * 10), min 0
}

export interface FixCycleBreakdown {
  design: number;
  plan: number;
  impl: number;
  reviewFixes: number;
  total: number;
}

export type TeamLevelName =
  | 'Prototype'           // Level 1
  | 'Alpha'               // Level 2
  | 'Beta'                // Level 3
  | 'Launched'            // Level 4
  | 'Growing'             // Level 5
  | 'Traction'            // Level 6
  | 'Product-Market Fit'  // Level 7
  | 'Scaling Up'          // Level 8
  | 'Compounding'         // Level 9
  | 'Scaling'             // Level 10
  | 'Dominating'          // Level 20
  ;

export interface TeamLevel {
  number: number;
  name: TeamLevelName;
  xpRequired: number;
  xpCurrent: number;
}

export interface WorkspaceDiscoveryResult {
  path: string;   // Absolute path to workspace directory
  slug: string;   // Basename of workspace directory
}
