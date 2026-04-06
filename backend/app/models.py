from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class JobMode(str, Enum):
    read_only = "read-only"
    workspace_write = "workspace-write"


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class WorkspaceWriteStrategy(str, Enum):
    disabled = "disabled"
    workspace_write = "workspace-write"
    danger_full_access = "danger-full-access"


class ReasoningEffort(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"
    xhigh = "xhigh"


class MessageRole(str, Enum):
    user = "user"
    assistant = "assistant"


class ConversationMessage(BaseModel):
    id: str
    role: MessageRole
    content: str
    created_at: str
    turn: int
    mode: JobMode | None = None
    model: str | None = None
    reasoning_effort: ReasoningEffort | None = None
    state: Literal["complete"] = "complete"


class JobRecord(BaseModel):
    id: str
    prompt: str
    title: str = ""
    mode: JobMode
    model: str = "gpt-5.4"
    reasoning_effort: ReasoningEffort = ReasoningEffort.xhigh
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
    worker_pid: int | None = None
    thread_id: str | None = None
    turn_count: int = 0
    messages: list[ConversationMessage] = Field(default_factory=list)
    changed_files: list[str] = Field(default_factory=list)
