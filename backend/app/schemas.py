from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from .models import JobMode, JobRecord, JobStatus, ReasoningEffort, WorkspaceWriteStrategy


class JobInputRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    mode: JobMode = JobMode.read_only
    model: str = Field(default="gpt-5.4", min_length=1, max_length=120)
    reasoning_effort: ReasoningEffort = ReasoningEffort.xhigh
    open_folder: str = Field(default=".", max_length=400)
    limit_to_open_folder: bool = False
    thread_id: str | None = Field(default=None, max_length=120)
    thread_title: str | None = Field(default=None, max_length=200)

    @field_validator("prompt")
    @classmethod
    def normalize_prompt(cls, value: str) -> str:
        prompt = value.strip()
        if not prompt:
            raise ValueError("Prompt cannot be empty.")
        return prompt

    @field_validator("model")
    @classmethod
    def normalize_model(cls, value: str) -> str:
        model = value.strip()
        if not model:
            raise ValueError("Model cannot be empty.")
        return model

    @field_validator("open_folder")
    @classmethod
    def normalize_open_folder(cls, value: str) -> str:
        folder = value.strip()
        if not folder or folder == "/":
            return "."
        return folder

    @field_validator("thread_id")
    @classmethod
    def normalize_thread_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        thread_id = value.strip()
        return thread_id or None

    @field_validator("thread_title")
    @classmethod
    def normalize_thread_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        title = value.strip()
        return title or None


class CreateJobRequest(JobInputRequest):
    pass


class AppendMessageRequest(JobInputRequest):
    pass


class JobStatusResponse(BaseModel):
    id: str
    mode: JobMode
    status: JobStatus
    updated_at: str
    started_at: str | None
    finished_at: str | None
    error: str | None
    executor: str
    return_code: int | None
    worker_pid: int | None
    thread_id: str | None
    open_folder: str
    limit_to_open_folder: bool


class LogsResponse(BaseModel):
    job_id: str
    offset: int
    next_offset: int
    chunk: str
    complete: bool


class JobsResponse(BaseModel):
    jobs: list[JobRecord]


class EventsResponse(BaseModel):
    job_id: str
    offset: int
    next_offset: int
    chunk: str
    complete: bool


class ModeCapabilityResponse(BaseModel):
    mode: JobMode
    label: str
    enabled: bool
    dangerous: bool
    launch_strategy: str
    executor: str
    description: str
    reason: str | None = None


class ModelOptionResponse(BaseModel):
    id: str
    label: str
    description: str
    recommended: bool = False


class ReasoningEffortOptionResponse(BaseModel):
    value: ReasoningEffort
    label: str
    description: str


class FolderEntryResponse(BaseModel):
    name: str
    path: str
    has_children: bool


class FolderBrowserResponse(BaseModel):
    root: str
    current_path: str
    parent_path: str | None
    entries: list[FolderEntryResponse]


class RuntimeInfoResponse(BaseModel):
    status: str
    workspace_root: str
    codex_bin: str
    workspace_write_strategy: WorkspaceWriteStrategy
    supports_websocket_streams: bool
    supports_native_thread_resume: bool
    default_model: str
    default_reasoning_effort: ReasoningEffort
    available_models: list[ModelOptionResponse]
    reasoning_efforts: list[ReasoningEffortOptionResponse]
    modes: list[ModeCapabilityResponse]


class CodexHistoryThreadSummaryResponse(BaseModel):
    id: str
    name: str
    preview: str
    created_at: str | None
    updated_at: str | None
    status: str
    active_flags: list[str] = Field(default_factory=list)
    source: str
    cwd: str
    model_provider: str | None
    cli_version: str | None
    path: str


class CodexHistoryMessageResponse(BaseModel):
    id: str
    role: str
    content: str
    turn_id: str
    turn_index: int
    phase: str | None
    source_item_type: str


class CodexHistoryThreadsResponse(BaseModel):
    threads: list[CodexHistoryThreadSummaryResponse]
    next_cursor: str | None = None


class CodexHistoryThreadResponse(BaseModel):
    thread: CodexHistoryThreadSummaryResponse
    messages: list[CodexHistoryMessageResponse]
