from __future__ import annotations

import json
import shlex
import subprocess
from threading import Thread

from ..config import Settings
from ..models import JobMode, JobRecord, JobStatus
from .snapshot import WorkspaceSnapshotBuilder
from .storage import JobStore, utc_now


class JobRunner:
    def __init__(self, settings: Settings, store: JobStore) -> None:
        self.settings = settings
        self.store = store
        self.snapshot_builder = WorkspaceSnapshotBuilder(settings.workspace_root)

    def start(self, job_id: str) -> None:
        thread = Thread(target=self._run_job, args=(job_id,), daemon=True)
        thread.start()

    def preview_command(self, mode: JobMode) -> list[str]:
        if mode != JobMode.read_only:
            return []
        return [
            self.settings.codex_bin,
            "exec",
            "--json",
            "--color",
            "never",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-",
        ]

    def _run_job(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        job.status = JobStatus.running
        job.executor = "codex-readonly-snapshot"
        job.command = self.preview_command(job.mode)
        job.started_at = utc_now()
        job.updated_at = job.started_at
        self.store.save_job(job)

        self.store.append_log(job.id, f"[system] Job {job.id} accepted")
        self.store.append_log(job.id, f"[system] Mode: {job.mode.value}")
        self.store.append_log(job.id, f"[system] Workspace: {job.cwd}")
        self.store.append_log(job.id, f"[user] {job.prompt}")

        try:
            snapshot = self.snapshot_builder.build(job.prompt)
            self.store.append_log(job.id, "[system] Built bounded workspace snapshot")
            self.store.append_log(
                job.id,
                f"[system] Snapshot characters: {len(snapshot)}",
            )
            self._run_codex(job, snapshot)
        except FileNotFoundError:
            self._fail_job(job, "The `codex` CLI was not found on this machine.")
        except Exception as exc:  # noqa: BLE001
            self._fail_job(job, f"Job failed unexpectedly: {exc}")

    def _run_codex(self, job: JobRecord, snapshot: str) -> None:
        prompt = self._build_prompt(job.prompt, snapshot)
        command = self.preview_command(job.mode)
        self.store.append_log(job.id, f"[system] Launching: {shlex.join(command)}")

        process = subprocess.Popen(
            command,
            cwd=job.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        assert process.stdin is not None
        process.stdin.write(prompt)
        process.stdin.close()

        final_output: str | None = None
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            self.store.append_event(job.id, line)
            rendered, possible_output = self._render_event(line)
            if rendered:
                self.store.append_log(job.id, rendered)
            if possible_output:
                final_output = possible_output

        return_code = process.wait()
        completed_job = self.store.get_job(job.id)
        completed_job.return_code = return_code
        completed_job.finished_at = utc_now()
        completed_job.updated_at = completed_job.finished_at
        completed_job.final_output = final_output

        if return_code == 0:
            completed_job.status = JobStatus.succeeded
            self.store.append_log(job.id, "[system] Job finished successfully")
        else:
            completed_job.status = JobStatus.failed
            completed_job.error = f"Codex exited with status {return_code}."
            self.store.append_log(job.id, f"[error] {completed_job.error}")

        self.store.save_job(completed_job)

    def _fail_job(self, job: JobRecord, message: str) -> None:
        failed_job = self.store.get_job(job.id)
        failed_job.status = JobStatus.failed
        failed_job.error = message
        failed_job.finished_at = utc_now()
        failed_job.updated_at = failed_job.finished_at
        self.store.save_job(failed_job)
        self.store.append_log(job.id, f"[error] {message}")

    def _build_prompt(self, user_prompt: str, snapshot: str) -> str:
        return (
            "You are Codex running inside a browser-based VPS runner.\n"
            "You are in strict read-only mode for this MVP.\n"
            "Do not call shell tools, MCP tools, or web search.\n"
            "Answer only from the workspace snapshot below.\n"
            "If the snapshot is insufficient, say exactly what is missing.\n\n"
            f"User task:\n{user_prompt}\n\n"
            f"Workspace snapshot:\n{snapshot}\n"
        )

    def _render_event(self, raw_line: str) -> tuple[str | None, str | None]:
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            if raw_line:
                return f"[raw] {raw_line}", None
            return None, None

        event_type = event.get("type")
        if event_type == "thread.started":
            return f"[system] Codex thread started: {event.get('thread_id')}", None
        if event_type == "turn.started":
            return "[system] Codex turn started", None
        if event_type == "turn.completed":
            usage = event.get("usage") or {}
            return (
                "[system] Codex turn completed "
                f"(input={usage.get('input_tokens', 0)}, output={usage.get('output_tokens', 0)})",
                None,
            )
        if event_type != "item.completed":
            return f"[event] {event_type}", None

        item = event.get("item") or {}
        item_type = item.get("type")
        if item_type == "agent_message":
            text = (item.get("text") or "").strip()
            if not text:
                return "[assistant] <empty response>", None
            return f"[assistant]\n{text}", text

        return f"[event] Completed {item_type}", None
