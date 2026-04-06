export type JobMode = "read-only" | "workspace-write";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type WorkspaceWriteStrategy = "disabled" | "workspace-write" | "danger-full-access";

export interface JobRecord {
  id: string;
  prompt: string;
  mode: JobMode;
  status: JobStatus;
  cwd: string;
  executor: string;
  command: string[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  final_output: string | null;
  error: string | null;
  return_code: number | null;
  worker_pid: number | null;
  changed_files: string[];
}

export interface JobsResponse {
  jobs: JobRecord[];
}

export interface CreateJobRequest {
  prompt: string;
  mode: JobMode;
}

export interface LogsResponse {
  job_id: string;
  offset: number;
  next_offset: number;
  chunk: string;
  complete: boolean;
}

export interface EventsResponse {
  job_id: string;
  offset: number;
  next_offset: number;
  chunk: string;
  complete: boolean;
}

export interface ModeCapability {
  mode: JobMode;
  label: string;
  enabled: boolean;
  dangerous: boolean;
  launch_strategy: string;
  executor: string;
  description: string;
  reason: string | null;
}

export interface RuntimeInfo {
  status: string;
  workspace_root: string;
  codex_bin: string;
  workspace_write_strategy: WorkspaceWriteStrategy;
  modes: ModeCapability[];
}
