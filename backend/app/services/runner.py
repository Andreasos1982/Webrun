from __future__ import annotations

import os
import signal
import subprocess
import sys

from ..config import Settings
from ..models import JobMode, JobStatus, ReasoningEffort
from .modes import build_exec_command, get_mode_spec
from .storage import JobStore, utc_now


class JobRunner:
    def __init__(self, settings: Settings, store: JobStore) -> None:
        self.settings = settings
        self.store = store

    def start(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        mode_spec = get_mode_spec(self.settings, job.mode)

        if not mode_spec.enabled:
            raise RuntimeError(mode_spec.reason or f"Job mode {job.mode.value} is not available.")

        try:
            subprocess.Popen(
                [sys.executable, "-m", "backend.app.worker", job_id],
                cwd=self.settings.project_root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
                text=False,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(f"Unable to launch the job worker: {exc}") from exc

    def preview_command(self, mode: JobMode, model: str, reasoning_effort: ReasoningEffort) -> list[str]:
        return build_exec_command(self.settings, mode, model=model, reasoning_effort=reasoning_effort)

    def cancel(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        if not job.worker_pid:
            return
        try:
            os.kill(job.worker_pid, signal.SIGTERM)
        except ProcessLookupError:
            return

    def fail_to_start(self, job_id: str, message: str) -> None:
        job = self.store.get_job(job_id)
        job.status = JobStatus.failed
        job.error = message
        job.finished_at = utc_now()
        job.updated_at = job.finished_at
        self.store.save_job(job)
        self.store.append_log(job_id, f"[error] {message}")
