export type JobMode = "read-only" | "workspace-write";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

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

