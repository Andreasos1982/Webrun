from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
from threading import Lock
from uuid import uuid4

from fastapi import HTTPException

from ..models import ConversationMessage, JobMode, JobRecord, JobStatus, MessageRole, ReasoningEffort


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class JobStore:
    def __init__(self, jobs_root: Path) -> None:
        self.jobs_root = jobs_root
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def create_job(
        self,
        prompt: str,
        mode: JobMode,
        cwd: str,
        model: str,
        reasoning_effort: ReasoningEffort,
        open_folder: str,
        limit_to_open_folder: bool,
    ) -> JobRecord:
        now = utc_now()
        normalized_prompt = prompt.strip()
        first_message = ConversationMessage(
            id=uuid4().hex,
            role=MessageRole.user,
            content=normalized_prompt,
            created_at=now,
            turn=1,
            mode=mode,
            model=model,
            reasoning_effort=reasoning_effort,
        )
        job = JobRecord(
            id=uuid4().hex[:12],
            prompt=normalized_prompt,
            title=self._build_title(normalized_prompt),
            mode=mode,
            model=model,
            reasoning_effort=reasoning_effort,
            open_folder=open_folder,
            limit_to_open_folder=limit_to_open_folder,
            status=JobStatus.queued,
            cwd=cwd,
            created_at=now,
            updated_at=now,
            turn_count=1,
            messages=[first_message],
        )

        job_dir = self._job_dir(job.id)
        job_dir.mkdir(parents=True, exist_ok=False)
        (job_dir / "events.jsonl").write_text("", encoding="utf-8")
        (job_dir / "output.log").write_text("", encoding="utf-8")
        self.save_job(job)
        return job

    def append_user_turn(
        self,
        job_id: str,
        prompt: str,
        mode: JobMode,
        model: str,
        reasoning_effort: ReasoningEffort,
        cwd: str,
        open_folder: str,
        limit_to_open_folder: bool,
    ) -> JobRecord:
        with self._lock:
            path = self._job_dir(job_id) / "job.json"
            if not path.exists():
                raise HTTPException(status_code=404, detail="Job not found.")

            job = self._read_job_file(path)
            if job.status in {JobStatus.queued, JobStatus.running}:
                raise HTTPException(status_code=409, detail="This session is already running.")

            now = utc_now()
            normalized_prompt = prompt.strip()
            turn = job.turn_count + 1
            job.mode = mode
            job.model = model
            job.reasoning_effort = reasoning_effort
            job.cwd = cwd
            job.open_folder = open_folder
            job.limit_to_open_folder = limit_to_open_folder
            job.status = JobStatus.queued
            job.error = None
            job.return_code = None
            job.worker_pid = None
            job.started_at = None
            job.finished_at = None
            job.cancel_requested_at = None
            job.executor = "pending"
            job.command = []
            job.final_output = None
            job.updated_at = now
            job.turn_count = turn
            job.messages.append(
                ConversationMessage(
                    id=uuid4().hex,
                    role=MessageRole.user,
                    content=normalized_prompt,
                    created_at=now,
                    turn=turn,
                    mode=mode,
                    model=model,
                    reasoning_effort=reasoning_effort,
                )
            )
            self._write_job_unlocked(job)
            return job

    def request_cancel(self, job_id: str) -> JobRecord:
        with self._lock:
            path = self._job_dir(job_id) / "job.json"
            if not path.exists():
                raise HTTPException(status_code=404, detail="Job not found.")

            job = self._read_job_file(path)
            if job.status in {JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled}:
                return job

            now = utc_now()
            job.cancel_requested_at = now
            job.updated_at = now

            if job.status == JobStatus.queued and job.worker_pid is None:
                job.status = JobStatus.cancelled
                job.finished_at = now
                job.error = None

            self._write_job_unlocked(job)
            return job

    def list_jobs(self) -> list[JobRecord]:
        jobs: list[JobRecord] = []
        for path in self.jobs_root.iterdir():
            if not path.is_dir():
                continue
            job_file = path / "job.json"
            if job_file.exists():
                jobs.append(self._reconcile_job(self._read_job_file(job_file)))
        return sorted(jobs, key=lambda item: item.updated_at, reverse=True)

    def get_job(self, job_id: str) -> JobRecord:
        job_file = self._job_dir(job_id) / "job.json"
        if not job_file.exists():
            raise HTTPException(status_code=404, detail="Job not found.")
        return self._reconcile_job(self._read_job_file(job_file))

    def save_job(self, job: JobRecord) -> JobRecord:
        path = self._job_dir(job.id) / "job.json"
        with self._lock:
            self._write_job_unlocked(job)
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

    def _write_job_unlocked(self, job: JobRecord) -> None:
        payload = job.model_dump(mode="json")
        path = self._job_dir(job.id) / "job.json"
        tmp_path = path.with_name(f"{path.name}.tmp")
        serialized = json.dumps(payload, indent=2)
        tmp_path.write_text(serialized, encoding="utf-8")
        tmp_path.replace(path)

    def _reconcile_job(self, job: JobRecord) -> JobRecord:
        updated = False

        if not job.title:
            job.title = self._build_title(job.prompt)
            updated = True

        if not job.open_folder:
            job.open_folder = "."
            updated = True

        if job.thread_open_folder is None and job.thread_id:
            job.thread_open_folder = job.open_folder
            updated = True

        if job.thread_limit_to_open_folder is None and job.thread_id:
            job.thread_limit_to_open_folder = job.limit_to_open_folder
            updated = True

        if not job.messages and job.prompt:
            job.messages.append(
                ConversationMessage(
                    id=uuid4().hex,
                    role=MessageRole.user,
                    content=job.prompt,
                    created_at=job.created_at,
                    turn=1,
                    mode=job.mode,
                    model=job.model,
                    reasoning_effort=job.reasoning_effort,
                )
            )
            if job.final_output:
                job.messages.append(
                    ConversationMessage(
                        id=uuid4().hex,
                        role=MessageRole.assistant,
                        content=job.final_output,
                        created_at=job.finished_at or job.updated_at,
                        turn=1,
                        mode=job.mode,
                        model=job.model,
                        reasoning_effort=job.reasoning_effort,
                    )
                )
            job.turn_count = 1
            updated = True

        if job.turn_count == 0 and job.messages:
            job.turn_count = max(message.turn for message in job.messages)
            updated = True

        if updated:
            self.save_job(job)

        if job.finished_at:
            return job

        if job.status == JobStatus.queued and job.worker_pid is None:
            if job.cancel_requested_at:
                job.status = JobStatus.cancelled
                job.error = None
                job.finished_at = utc_now()
                job.updated_at = job.finished_at
                self.save_job(job)
                return job
            queue_reference = job.updated_at or job.created_at
            age_seconds = (datetime.now(timezone.utc) - parse_utc(queue_reference)).total_seconds()
            if age_seconds >= 15:
                job.status = JobStatus.failed
                job.error = job.error or "Job worker did not start."
                job.finished_at = utc_now()
                job.updated_at = job.finished_at
                self.save_job(job)
            return job

        if job.worker_pid and job.status in {JobStatus.queued, JobStatus.running} and not self._pid_exists(job.worker_pid):
            if job.cancel_requested_at:
                job.status = JobStatus.cancelled
                job.error = None
            else:
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

    def _build_title(self, prompt: str) -> str:
        single_line = " ".join(prompt.split())
        if len(single_line) <= 64:
            return single_line
        return f"{single_line[:61]}..."
