export type WorkspaceStatus = 'active' | 'waiting' | 'parked' | 'idle' | 'attention';

/**
 * Whether a registered folder is usable right now (#0039). Anything but `ok` is a stub: empty arrays, not parsed, not watched.
 * `budget` means the folder was not probed yet because too many slow folders hold the probe budget; it is not a verdict on the folder.
 */
export type Availability = 'checking' | 'ok' | 'missing' | 'unreachable' | 'not-a-directory' | 'unsafe' | 'moved' | 'budget';

/** How a workspace got into the registry. */
export type WorkspaceSource = 'manual' | 'discovered';

export interface Workspace {
  slug: string;                    // The registry id (kept under the old name), e.g. "seraph"
  path: string;                    // Absolute realpath, e.g. "/home/amer/seraph"
  selectedPath: string;            // The path as chosen (normalized, not realpath'd); event matching only
  hidden: boolean;                 // Office skin only
  source: WorkspaceSource;
  hasRix: boolean;                 // The folder has a `.rix` directory (Rix features are available)
  availability: Availability;
  displayName: string;             // Custom name or slug, title-cased
  docsRoot: string;                // Absolute path to docs_root
  docsRootExists: boolean;         // Whether the docs_root directory exists on disk
  /**
   * The docs root the repo or user chose, and the `<path>/docs` default, were both refused (they are, or lead into, an
   * app folder or an unsafe root). `docsRoot` is then only the default location for display: docs are not scanned,
   * served or watched. Absent means `false`.
   */
  docsRootRefused?: boolean;
  /** The approved docs root did not exist when it was approved; it is verified again on first use. Absent means `false`. */
  docsRootUnverified?: boolean;
  repoRootStatus: 'ok' | 'missing' | 'unsafe'; // Runtime-only; drives the code explorer's FR-1 disabled state (#0028, M3)
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
