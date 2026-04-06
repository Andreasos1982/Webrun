from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class JobMode(str, Enum):
    read_only = "read-only"
    workspace_write = "workspace-write"


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class JobRecord(BaseModel):
    id: str
    prompt: str
    mode: JobMode
    status: JobStatus
    cwd: str
    executor: str = "pending"
    command: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str
    started_at: str | None = None
    finished_at: str | None = None
    final_output: str | None = None
    error: str | None = None
    return_code: int | None = None

