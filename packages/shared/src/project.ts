export interface HealthResponse {
  ok: boolean;
  version: string;
}

export interface ProjectCounts {
  sourceFiles: number;
  documents: number;
  references: number;
}

export interface ProjectStatus {
  initialized: boolean;
  projectPath: string | null;
  dissertatorDir: string | null;
  createdAt: string | null;
  counts: ProjectCounts;
}

export interface InitProjectResponse {
  projectPath: string;
  dissertatorDir: string;
  dbPath: string;
  createdAt: string;
  created: boolean; // false if project already existed
}

/** Agent authoring modes. */
export type AgentMode = "accept_all" | "confirm_edits";
