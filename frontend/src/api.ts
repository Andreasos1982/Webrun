import type {
  AppendMessageRequest,
  CodexHistoryThreadDetail,
  CodexHistoryThreadsResponse,
  CreateJobRequest,
  EventsResponse,
  FolderBrowserResponse,
  JobRecord,
  JobsResponse,
  LogsResponse,
  RuntimeInfo,
} from "./types";

const inferredApiBase = `${window.location.origin}/api`;
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? inferredApiBase;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;

    try {
      const parsed = JSON.parse(text) as { detail?: string };
      if (parsed.detail) {
        message = parsed.detail;
      }
    } catch {
      // Keep the raw text fallback.
    }

    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchRuntime(): Promise<RuntimeInfo> {
  return request<RuntimeInfo>("/runtime");
}

export function listJobs(): Promise<JobsResponse> {
  return request<JobsResponse>("/jobs");
}

export function fetchJob(jobId: string): Promise<JobRecord> {
  return request<JobRecord>(`/jobs/${jobId}`);
}

export function createJob(payload: CreateJobRequest): Promise<JobRecord> {
  return request<JobRecord>("/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function appendMessage(jobId: string, payload: AppendMessageRequest): Promise<JobRecord> {
  return request<JobRecord>(`/jobs/${jobId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function cancelJob(jobId: string): Promise<JobRecord> {
  return request<JobRecord>(`/jobs/${jobId}/cancel`, {
    method: "POST",
  });
}

export function fetchLogs(jobId: string, offset: number): Promise<LogsResponse> {
  return request<LogsResponse>(`/jobs/${jobId}/logs?offset=${offset}`);
}

export function fetchEvents(jobId: string, offset: number): Promise<EventsResponse> {
  return request<EventsResponse>(`/jobs/${jobId}/events?offset=${offset}`);
}

export function fetchFolders(path = "."): Promise<FolderBrowserResponse> {
  return request<FolderBrowserResponse>(`/folders?path=${encodeURIComponent(path)}`);
}

export function listCodexHistory(
  limit = 40,
  cursor?: string,
  search?: string,
): Promise<CodexHistoryThreadsResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set("cursor", cursor);
  }
  if (search) {
    params.set("search", search);
  }
  return request<CodexHistoryThreadsResponse>(`/codex-history?${params.toString()}`);
}

export function fetchCodexHistoryThread(threadId: string): Promise<CodexHistoryThreadDetail> {
  return request<CodexHistoryThreadDetail>(`/codex-history/${encodeURIComponent(threadId)}`);
}

export function jobStreamUrl(jobId: string): string {
  const base = new URL(`${API_BASE.replace(/\/$/, "")}/ws/jobs/${jobId}`, window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return base.toString();
}
