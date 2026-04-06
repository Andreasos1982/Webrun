from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from .models import JobMode, JobRecord, JobStatus, ReasoningEffort, WorkspaceWriteStrategy


class JobInputRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    mode: JobMode = JobMode.read_only
    model: str = Field(default="gpt-5.4", min_length=1, max_length=120)
    reasoning_effort: ReasoningEffort = ReasoningEffort.xhigh

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


class RuntimeInfoResponse(BaseModel):
    status: str
    workspace_root: str
    codex_bin: str
    workspace_write_strategy: WorkspaceWriteStrategy
    default_model: str
    default_reasoning_effort: ReasoningEffort
    available_models: list[ModelOptionResponse]
    reasoning_efforts: list[ReasoningEffortOptionResponse]
    modes: list[ModeCapabilityResponse]
