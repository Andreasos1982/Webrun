from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
from threading import Lock
from uuid import uuid4

from fastapi import HTTPException

from ..models import JobMode, JobRecord, JobStatus


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class JobStore:
    def __init__(self, jobs_root: Path) -> None:
        self.jobs_root = jobs_root
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def create_job(self, prompt: str, mode: JobMode, cwd: str) -> JobRecord:
        now = utc_now()
        job = JobRecord(
            id=uuid4().hex[:12],
            prompt=prompt,
            mode=mode,
            status=JobStatus.queued,
            cwd=cwd,
            created_at=now,
            updated_at=now,
        )

        job_dir = self._job_dir(job.id)
        job_dir.mkdir(parents=True, exist_ok=False)
        (job_dir / "events.jsonl").write_text("", encoding="utf-8")
        (job_dir / "output.log").write_text("", encoding="utf-8")
        self.save_job(job)
        return job

    def list_jobs(self) -> list[JobRecord]:
        jobs: list[JobRecord] = []
        for path in self.jobs_root.iterdir():
            if not path.is_dir():
                continue
            job_file = path / "job.json"
            if job_file.exists():
                jobs.append(self._reconcile_job(self._read_job_file(job_file)))
        return sorted(jobs, key=lambda item: item.created_at, reverse=True)

    def get_job(self, job_id: str) -> JobRecord:
        job_file = self._job_dir(job_id) / "job.json"
        if not job_file.exists():
            raise HTTPException(status_code=404, detail="Job not found.")
        return self._reconcile_job(self._read_job_file(job_file))

    def save_job(self, job: JobRecord) -> JobRecord:
        payload = job.model_dump(mode="json")
        path = self._job_dir(job.id) / "job.json"
        tmp_path = path.with_name(f"{path.name}.tmp")
        serialized = json.dumps(payload, indent=2)
        with self._lock:
            tmp_path.write_text(serialized, encoding="utf-8")
            tmp_path.replace(path)
        return job

    def append_event(self, job_id: str, line: str) -> None:
        self._append_line(self._job_dir(job_id) / "events.jsonl", line)

    def append_log(self, job_id: str, line: str) -> None:
        self._append_line(self._job_dir(job_id) / "output.log", line)

    def read_logs(self, job_id: str, offset: int = 0, limit: int = 65536) -> tuple[str, int]:
        return self._read_file_chunk(self._job_dir(job_id) / "output.log", offset=offset, limit=limit)

    def read_events(self, job_id: str, offset: int = 0, limit: int = 65536) -> tuple[str, int]:
        return self._read_file_chunk(self._job_dir(job_id) / "events.jsonl", offset=offset, limit=limit)

    def _append_line(self, path: Path, line: str) -> None:
        payload = line.rstrip("\n") + "\n"
        with self._lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(payload)

    def _read_file_chunk(self, path: Path, offset: int, limit: int) -> tuple[str, int]:
        with self._lock:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                safe_offset = min(max(offset, 0), size)
                handle.seek(safe_offset)
                chunk = handle.read(limit)
        return chunk.decode("utf-8", errors="replace"), safe_offset + len(chunk)

    def _job_dir(self, job_id: str) -> Path:
        return self.jobs_root / job_id

    def _read_job_file(self, path: Path) -> JobRecord:
        return JobRecord.model_validate_json(path.read_text(encoding="utf-8"))

    def _reconcile_job(self, job: JobRecord) -> JobRecord:
        if job.finished_at:
            return job

        if job.status == JobStatus.queued and job.worker_pid is None:
            age_seconds = (datetime.now(timezone.utc) - parse_utc(job.created_at)).total_seconds()
            if age_seconds >= 15:
                job.status = JobStatus.failed
                job.error = job.error or "Job worker did not start."
                job.finished_at = utc_now()
                job.updated_at = job.finished_at
                self.save_job(job)
            return job

        if job.worker_pid and job.status in {JobStatus.queued, JobStatus.running} and not self._pid_exists(job.worker_pid):
            job.status = JobStatus.failed
            job.error = job.error or "Job worker stopped before reporting completion."
            job.finished_at = utc_now()
            job.updated_at = job.finished_at
            self.save_job(job)

        return job

    def _pid_exists(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
