from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .models import JobRecord, JobStatus
from .schemas import (
    CreateJobRequest,
    EventsResponse,
    JobStatusResponse,
    JobsResponse,
    LogsResponse,
    ModeCapabilityResponse,
    RuntimeInfoResponse,
)
from .services.runner import JobRunner
from .services.modes import list_mode_specs
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
        "workspace_write_strategy": settings.workspace_write_strategy.value,
    }


@app.get("/api/runtime", response_model=RuntimeInfoResponse)
def runtime_info() -> RuntimeInfoResponse:
    modes = [
        ModeCapabilityResponse(
            mode=spec.mode,
            label=spec.label,
            enabled=spec.enabled,
            dangerous=spec.dangerous,
            launch_strategy=spec.launch_strategy,
            executor=spec.executor,
            description=spec.description,
            reason=spec.reason,
        )
        for spec in list_mode_specs(settings)
    ]
    return RuntimeInfoResponse(
        status="ok",
        workspace_root=str(settings.workspace_root),
        codex_bin=settings.codex_bin,
        workspace_write_strategy=settings.workspace_write_strategy,
        modes=modes,
    )


@app.get("/api/jobs", response_model=JobsResponse)
def list_jobs() -> JobsResponse:
    return JobsResponse(jobs=store.list_jobs())


@app.post("/api/jobs", response_model=JobRecord, status_code=201)
def create_job(payload: CreateJobRequest) -> JobRecord:
    mode_spec = next((spec for spec in list_mode_specs(settings) if spec.mode == payload.mode), None)
    if mode_spec is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported job mode: {payload.mode.value}",
        )
    if not mode_spec.enabled:
        raise HTTPException(status_code=400, detail=mode_spec.reason or "This job mode is not available.")

    job = store.create_job(
        prompt=payload.prompt,
        mode=payload.mode,
        cwd=str(settings.workspace_root),
    )
    try:
        runner.start(job.id)
    except RuntimeError as exc:
        runner.fail_to_start(job.id, str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return job


@app.get("/api/jobs/{job_id}", response_model=JobRecord)
def get_job(job_id: str) -> JobRecord:
    return store.get_job(job_id)


@app.get("/api/jobs/{job_id}/status", response_model=JobStatusResponse)
def get_job_status(job_id: str) -> JobStatusResponse:
    job = store.get_job(job_id)
    return JobStatusResponse(
        id=job.id,
        mode=job.mode,
        status=job.status,
        updated_at=job.updated_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        error=job.error,
        executor=job.executor,
        return_code=job.return_code,
        worker_pid=job.worker_pid,
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


@app.get("/api/jobs/{job_id}/events", response_model=EventsResponse)
def get_job_events(
    job_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=65536, ge=1, le=262144),
) -> EventsResponse:
    job = store.get_job(job_id)
    chunk, next_offset = store.read_events(job_id, offset=offset, limit=limit)
    return EventsResponse(
        job_id=job_id,
        offset=offset,
        next_offset=next_offset,
        chunk=chunk,
        complete=job.status in {JobStatus.succeeded, JobStatus.failed},
    )
