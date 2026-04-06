import type { CreateJobRequest, JobRecord, JobsResponse, LogsResponse } from "./types";

const inferredApiBase = `${window.location.protocol}//${window.location.hostname}:8000/api`;
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
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function listJobs(): Promise<JobsResponse> {
  return request<JobsResponse>("/jobs");
}

export function createJob(payload: CreateJobRequest): Promise<JobRecord> {
  return request<JobRecord>("/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchLogs(jobId: string, offset: number): Promise<LogsResponse> {
  return request<LogsResponse>(`/jobs/${jobId}/logs?offset=${offset}`);
}

