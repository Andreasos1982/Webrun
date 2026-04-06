from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .models import JobMode, JobRecord, JobStatus
from .schemas import CreateJobRequest, JobStatusResponse, JobsResponse, LogsResponse
from .services.runner import JobRunner
from .services.storage import JobStore


settings = get_settings()
store = JobStore(settings.jobs_root)
runner = JobRunner(settings, store)

app = FastAPI(title="Codex Web Runner", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "workspace_root": str(settings.workspace_root),
        "codex_bin": settings.codex_bin,
    }


@app.get("/api/jobs", response_model=JobsResponse)
def list_jobs() -> JobsResponse:
    return JobsResponse(jobs=store.list_jobs())


@app.post("/api/jobs", response_model=JobRecord, status_code=201)
def create_job(payload: CreateJobRequest) -> JobRecord:
    if payload.mode != JobMode.read_only:
        raise HTTPException(
            status_code=400,
            detail="Only read-only jobs are enabled in this MVP. Add a write executor next.",
        )

    job = store.create_job(
        prompt=payload.prompt,
        mode=payload.mode,
        cwd=str(settings.workspace_root),
    )
    runner.start(job.id)
    return job


@app.get("/api/jobs/{job_id}", response_model=JobRecord)
def get_job(job_id: str) -> JobRecord:
    return store.get_job(job_id)


@app.get("/api/jobs/{job_id}/status", response_model=JobStatusResponse)
def get_job_status(job_id: str) -> JobStatusResponse:
    job = store.get_job(job_id)
    return JobStatusResponse(
        id=job.id,
        status=job.status,
        updated_at=job.updated_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        error=job.error,
        executor=job.executor,
    )


@app.get("/api/jobs/{job_id}/logs", response_model=LogsResponse)
def get_job_logs(
    job_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=65536, ge=1, le=262144),
) -> LogsResponse:
    job = store.get_job(job_id)
    chunk, next_offset = store.read_logs(job_id, offset=offset, limit=limit)
    return LogsResponse(
        job_id=job_id,
        offset=offset,
        next_offset=next_offset,
        chunk=chunk,
        complete=job.status in {JobStatus.succeeded, JobStatus.failed},
    )
