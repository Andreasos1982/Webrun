from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import get_settings
from .models import JobRecord, JobStatus, ReasoningEffort
from .schemas import (
    AppendMessageRequest,
    CreateJobRequest,
    EventsResponse,
    JobStatusResponse,
    JobsResponse,
    LogsResponse,
    ModelOptionResponse,
    ModeCapabilityResponse,
    ReasoningEffortOptionResponse,
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

frontend_dist_root = settings.frontend_dist_root
frontend_index_file = frontend_dist_root / "index.html"


MODEL_COPY: dict[str, str] = {
    "gpt-5.4": "Recommended default for most coding work in Codex.",
    "gpt-5.3-codex": "Codex-optimized coding model for deeper implementation work.",
    "gpt-5.3-codex-spark": "Faster lightweight Codex model when latency matters most.",
}

REASONING_COPY: dict[ReasoningEffort, tuple[str, str]] = {
    ReasoningEffort.low: ("Niedrig", "Faster responses with lighter reasoning."),
    ReasoningEffort.medium: ("Mittel", "Balanced speed and reasoning depth for everyday tasks."),
    ReasoningEffort.high: ("Hoch", "More deliberate reasoning for tricky code and debugging work."),
    ReasoningEffort.xhigh: ("Extra hoch", "Maximum reasoning depth for the hardest tasks on this host."),
}


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
    available_models = [
        ModelOptionResponse(
            id=model_id,
            label=model_id.upper() if model_id.startswith("gpt-") else model_id,
            description=MODEL_COPY.get(model_id, "Available model configured for this Codex host."),
            recommended=model_id == settings.default_model,
        )
        for model_id in settings.available_models
    ]
    reasoning_efforts = [
        ReasoningEffortOptionResponse(
            value=effort,
            label=REASONING_COPY[effort][0],
            description=REASONING_COPY[effort][1],
        )
        for effort in ReasoningEffort
    ]
    return RuntimeInfoResponse(
        status="ok",
        workspace_root=str(settings.workspace_root),
        codex_bin=settings.codex_bin,
        workspace_write_strategy=settings.workspace_write_strategy,
        default_model=settings.default_model,
        default_reasoning_effort=settings.default_reasoning_effort,
        available_models=available_models,
        reasoning_efforts=reasoning_efforts,
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
        model=payload.model,
        reasoning_effort=payload.reasoning_effort,
    )
    try:
        runner.start(job.id)
    except RuntimeError as exc:
        runner.fail_to_start(job.id, str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return job


@app.post("/api/jobs/{job_id}/messages", response_model=JobRecord)
def append_job_message(job_id: str, payload: AppendMessageRequest) -> JobRecord:
    mode_spec = next((spec for spec in list_mode_specs(settings) if spec.mode == payload.mode), None)
    if mode_spec is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported job mode: {payload.mode.value}",
        )
    if not mode_spec.enabled:
        raise HTTPException(status_code=400, detail=mode_spec.reason or "This job mode is not available.")

    job = store.append_user_turn(
        job_id=job_id,
        prompt=payload.prompt,
        mode=payload.mode,
        model=payload.model,
        reasoning_effort=payload.reasoning_effort,
    )
    try:
        runner.start(job.id)
    except RuntimeError as exc:
        runner.fail_to_start(job.id, str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return store.get_job(job.id)


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
        thread_id=job.thread_id,
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


def _safe_frontend_path(relative_path: str) -> Path | None:
    if not relative_path:
        return None

    candidate = (frontend_dist_root / relative_path).resolve()
    try:
        candidate.relative_to(frontend_dist_root.resolve())
    except ValueError:
        return None

    if candidate.is_file():
        return candidate
    return None


@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend(full_path: str) -> FileResponse:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not Found")

    asset_path = _safe_frontend_path(full_path)
    if asset_path is not None:
        return FileResponse(asset_path)

    if frontend_index_file.exists():
        return FileResponse(frontend_index_file)

    raise HTTPException(
        status_code=503,
        detail="Frontend build not found. Run `npm run build` in `frontend/` before serving the app.",
    )
