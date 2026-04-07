from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import get_settings
from .models import JobRecord, JobStatus, ReasoningEffort
from .schemas import (
    AppendMessageRequest,
    CodexHistoryThreadResponse,
    CodexHistoryThreadsResponse,
    CreateJobRequest,
    EventsResponse,
    FolderBrowserResponse,
    FolderEntryResponse,
    JobStatusResponse,
    JobsResponse,
    LogsResponse,
    ModelOptionResponse,
    ModeCapabilityResponse,
    ReasoningEffortOptionResponse,
    RuntimeInfoResponse,
)
from .services.codex_history import CodexHistoryService
from .services.runner import JobRunner
from .services.modes import list_mode_specs, supports_native_resume
from .services.storage import JobStore


settings = get_settings()
store = JobStore(settings.jobs_root)
runner = JobRunner(settings, store)
codex_history = CodexHistoryService(settings)

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

BROWSE_IGNORED_PARTS = {
    ".git",
    ".venv",
    "__pycache__",
    "node_modules",
}

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


def _resolve_open_folder(open_folder: str) -> tuple[str, Path]:
    normalized = open_folder.strip() or "."
    relative = Path(normalized)
    if relative.is_absolute():
        raise HTTPException(status_code=400, detail="Open folder must stay within the workspace root.")

    candidate = (settings.workspace_root / relative).resolve()
    workspace_root = settings.workspace_root.resolve()
    try:
        candidate.relative_to(workspace_root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Open folder must stay within the workspace root.") from exc

    if not candidate.exists() or not candidate.is_dir():
        raise HTTPException(status_code=400, detail="Open folder does not exist.")

    relative_path = candidate.relative_to(workspace_root).as_posix() or "."
    return relative_path, candidate


def _ensure_mode_enabled(mode_value: str) -> ModeCapabilityResponse:
    mode_spec = next((spec for spec in list_mode_specs(settings) if spec.mode == mode_value), None)
    if mode_spec is None:
        raise HTTPException(status_code=400, detail=f"Unsupported job mode: {mode_value}")
    if not mode_spec.enabled:
        raise HTTPException(status_code=400, detail=mode_spec.reason or "This job mode is not available.")
    return ModeCapabilityResponse(
        mode=mode_spec.mode,
        label=mode_spec.label,
        enabled=mode_spec.enabled,
        dangerous=mode_spec.dangerous,
        launch_strategy=mode_spec.launch_strategy,
        executor=mode_spec.executor,
        description=mode_spec.description,
        reason=mode_spec.reason,
    )


def _serialize_job(job: JobRecord) -> dict:
    return job.model_dump(mode="json")


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
    supports_resume = any(supports_native_resume(settings, spec.mode) for spec in list_mode_specs(settings))
    return RuntimeInfoResponse(
        status="ok",
        workspace_root=str(settings.workspace_root),
        codex_bin=settings.codex_bin,
        workspace_write_strategy=settings.workspace_write_strategy,
        supports_websocket_streams=True,
        supports_native_thread_resume=supports_resume,
        default_model=settings.default_model,
        default_reasoning_effort=settings.default_reasoning_effort,
        available_models=available_models,
        reasoning_efforts=reasoning_efforts,
        modes=modes,
    )


@app.get("/api/folders", response_model=FolderBrowserResponse)
def browse_folders(path: str = Query(default=".")) -> FolderBrowserResponse:
    current_path, current_dir = _resolve_open_folder(path)
    root = settings.workspace_root.resolve()

    entries: list[FolderEntryResponse] = []
    for child in sorted(current_dir.iterdir(), key=lambda item: item.name.lower()):
        if not child.is_dir():
            continue
        if child.name in BROWSE_IGNORED_PARTS:
            continue
        child_path = child.relative_to(root).as_posix() or "."
        has_children = any(
            grandchild.is_dir() and grandchild.name not in BROWSE_IGNORED_PARTS
            for grandchild in child.iterdir()
        )
        entries.append(
            FolderEntryResponse(
                name=child.name,
                path=child_path,
                has_children=has_children,
            )
        )

    parent_path: str | None = None
    if current_path != ".":
        parent = current_dir.parent
        parent_path = parent.relative_to(root).as_posix() or "."

    return FolderBrowserResponse(
        root=".",
        current_path=current_path,
        parent_path=parent_path,
        entries=entries,
    )


@app.get("/api/jobs", response_model=JobsResponse)
def list_jobs() -> JobsResponse:
    return JobsResponse(jobs=store.list_jobs())


@app.get("/api/codex-history", response_model=CodexHistoryThreadsResponse)
def list_codex_history(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=40, ge=1, le=100),
    search: str | None = Query(default=None, max_length=240),
) -> CodexHistoryThreadsResponse:
    return CodexHistoryThreadsResponse.model_validate(
        codex_history.list_threads(limit=limit, cursor=cursor, search_term=search)
    )


@app.get("/api/codex-history/{thread_id}", response_model=CodexHistoryThreadResponse)
def get_codex_history_thread(thread_id: str) -> CodexHistoryThreadResponse:
    return CodexHistoryThreadResponse.model_validate(codex_history.read_thread(thread_id))


@app.post("/api/jobs", response_model=JobRecord, status_code=201)
def create_job(payload: CreateJobRequest) -> JobRecord:
    _ensure_mode_enabled(payload.mode.value)
    open_folder, cwd = _resolve_open_folder(payload.open_folder)

    job = store.create_job(
        prompt=payload.prompt,
        mode=payload.mode,
        cwd=str(cwd),
        model=payload.model,
        reasoning_effort=payload.reasoning_effort,
        open_folder=open_folder,
        limit_to_open_folder=payload.limit_to_open_folder,
    )
    try:
        runner.start(job.id)
    except RuntimeError as exc:
        runner.fail_to_start(job.id, str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return store.get_job(job.id)


@app.post("/api/jobs/{job_id}/messages", response_model=JobRecord)
def append_job_message(job_id: str, payload: AppendMessageRequest) -> JobRecord:
    _ensure_mode_enabled(payload.mode.value)
    open_folder, cwd = _resolve_open_folder(payload.open_folder)

    job = store.append_user_turn(
        job_id=job_id,
        prompt=payload.prompt,
        mode=payload.mode,
        model=payload.model,
        reasoning_effort=payload.reasoning_effort,
        cwd=str(cwd),
        open_folder=open_folder,
        limit_to_open_folder=payload.limit_to_open_folder,
    )
    try:
        runner.start(job.id)
    except RuntimeError as exc:
        runner.fail_to_start(job.id, str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return store.get_job(job.id)


@app.post("/api/jobs/{job_id}/cancel", response_model=JobRecord)
def cancel_job(job_id: str) -> JobRecord:
    job = store.request_cancel(job_id)
    if job.status not in {JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled}:
        runner.cancel(job.id)
        store.append_log(job.id, "[system] Cancellation requested by the browser.")
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
        open_folder=job.open_folder,
        limit_to_open_folder=job.limit_to_open_folder,
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
        complete=job.status in {JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled},
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
        complete=job.status in {JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled},
    )


@app.websocket("/api/ws/jobs/{job_id}")
async def stream_job(job_id: str, websocket: WebSocket) -> None:
    await websocket.accept()

    try:
        job = store.get_job(job_id)
    except HTTPException:
        await websocket.close(code=4404)
        return

    logs, logs_offset = store.read_logs(job_id, offset=0, limit=262144)
    events, events_offset = store.read_events(job_id, offset=0, limit=262144)
    last_signature = (
        job.updated_at,
        job.status.value,
        job.executor,
        job.return_code,
        len(job.messages),
        len(job.changed_files),
        job.worker_pid,
        job.thread_id,
        job.cancel_requested_at,
    )

    await websocket.send_json(
        {
            "type": "snapshot",
            "job": _serialize_job(job),
            "logs": logs,
            "events": events,
        }
    )

    try:
        while True:
            await asyncio.sleep(0.7)
            job = store.get_job(job_id)
            signature = (
                job.updated_at,
                job.status.value,
                job.executor,
                job.return_code,
                len(job.messages),
                len(job.changed_files),
                job.worker_pid,
                job.thread_id,
                job.cancel_requested_at,
            )

            if signature != last_signature:
                await websocket.send_json({"type": "job", "job": _serialize_job(job)})
                last_signature = signature

            log_chunk, next_logs_offset = store.read_logs(job_id, offset=logs_offset, limit=65536)
            if log_chunk:
                await websocket.send_json({"type": "logs", "chunk": log_chunk})
                logs_offset = next_logs_offset

            event_chunk, next_events_offset = store.read_events(job_id, offset=events_offset, limit=65536)
            if event_chunk:
                await websocket.send_json({"type": "events", "chunk": event_chunk})
                events_offset = next_events_offset

            if not log_chunk and not event_chunk:
                await websocket.send_json({"type": "heartbeat"})
    except WebSocketDisconnect:
        return


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
