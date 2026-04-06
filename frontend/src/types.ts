export type JobMode = "read-only" | "workspace-write";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type WorkspaceWriteStrategy = "disabled" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type MessageRole = "user" | "assistant";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  turn: number;
  mode: JobMode | null;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  state: "complete";
}

export interface JobRecord {
  id: string;
  prompt: string;
  title: string;
  mode: JobMode;
  model: string;
  reasoning_effort: ReasoningEffort;
  open_folder: string;
  limit_to_open_folder: boolean;
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
  thread_id: string | null;
  thread_mode: JobMode | null;
  thread_cwd: string | null;
  thread_open_folder: string | null;
  thread_limit_to_open_folder: boolean | null;
  cancel_requested_at: string | null;
  turn_count: number;
  messages: ConversationMessage[];
  changed_files: string[];
}

export interface JobsResponse {
  jobs: JobRecord[];
}

export interface CreateJobRequest {
  prompt: string;
  mode: JobMode;
  model: string;
  reasoning_effort: ReasoningEffort;
  open_folder: string;
  limit_to_open_folder: boolean;
}

export interface AppendMessageRequest {
  prompt: string;
  mode: JobMode;
  model: string;
  reasoning_effort: ReasoningEffort;
  open_folder: string;
  limit_to_open_folder: boolean;
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

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
}

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  label: string;
  description: string;
}

export interface FolderEntry {
  name: string;
  path: string;
  has_children: boolean;
}

export interface FolderBrowserResponse {
  root: string;
  current_path: string;
  parent_path: string | null;
  entries: FolderEntry[];
}

export interface RuntimeInfo {
  status: string;
  workspace_root: string;
  codex_bin: string;
  workspace_write_strategy: WorkspaceWriteStrategy;
  supports_websocket_streams: boolean;
  supports_native_thread_resume: boolean;
  default_model: string;
  default_reasoning_effort: ReasoningEffort;
  available_models: ModelOption[];
  reasoning_efforts: ReasoningEffortOption[];
  modes: ModeCapability[];
}
