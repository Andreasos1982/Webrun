from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from .models import JobMode, JobRecord, JobStatus


class CreateJobRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    mode: JobMode = JobMode.read_only

    @field_validator("prompt")
    @classmethod
    def normalize_prompt(cls, value: str) -> str:
        prompt = value.strip()
        if not prompt:
            raise ValueError("Prompt cannot be empty.")
        return prompt


class JobStatusResponse(BaseModel):
    id: str
    status: JobStatus
    updated_at: str
    started_at: str | None
    finished_at: str | None
    error: str | None
    executor: str


class LogsResponse(BaseModel):
    job_id: str
    offset: int
    next_offset: int
    chunk: str
    complete: bool


class JobsResponse(BaseModel):
    jobs: list[JobRecord]

