from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

from .config import get_settings
from .models import JobRecord, JobStatus
from .services.modes import ModeSpec, get_mode_spec
from .services.snapshot import WorkspaceSnapshotBuilder
from .services.storage import JobStore, utc_now


@dataclass(frozen=True)
class RenderedEvent:
    log_line: str | None = None
    final_output: str | None = None
    changed_files: tuple[str, ...] = field(default_factory=tuple)


class JobWorker:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.store = JobStore(self.settings.jobs_root)
        self.snapshot_builder = WorkspaceSnapshotBuilder(self.settings.workspace_root)

    def run(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        mode_spec = get_mode_spec(self.settings, job.mode)

        if not mode_spec.enabled:
            self._fail_job(job, mode_spec.reason or f"Job mode {job.mode.value} is not available.")
            return

        job.status = JobStatus.running
        job.executor = mode_spec.executor
        job.command = mode_spec.command
        job.worker_pid = os.getpid()
        job.started_at = utc_now()
        job.updated_at = job.started_at
        self.store.save_job(job)

        self.store.append_log(job.id, f"[system] Job {job.id} accepted")
        self.store.append_log(job.id, f"[system] Mode: {job.mode.value}")
        self.store.append_log(job.id, f"[system] Workspace: {job.cwd}")
        self.store.append_log(job.id, f"[system] Worker PID: {job.worker_pid}")
        self.store.append_log(job.id, f"[system] Executor: {mode_spec.executor}")
        if mode_spec.dangerous:
            self.store.append_log(
                job.id,
                "[warning] Live write mode is running without the native Codex sandbox on this host.",
            )
        self.store.append_log(job.id, f"[user] {job.prompt}")

        try:
            prompt = self._build_prompt(job, mode_spec)
            self._run_codex(job, mode_spec, prompt)
        except FileNotFoundError:
            self._fail_job(job, "The `codex` CLI was not found on this machine.")
        except Exception as exc:  # noqa: BLE001
            self._fail_job(job, f"Job failed unexpectedly: {exc}")

    def _build_prompt(self, job: JobRecord, mode_spec: ModeSpec) -> str:
        if mode_spec.launch_strategy == "snapshot":
            snapshot = self.snapshot_builder.build(job.prompt)
            self.store.append_log(job.id, "[system] Built bounded workspace snapshot")
            self.store.append_log(job.id, f"[system] Snapshot characters: {len(snapshot)}")
            return (
                "You are Codex running inside a browser-based VPS runner.\n"
                "You are in strict read-only mode for this job.\n"
                "Do not call shell tools, MCP tools, or web search.\n"
                "Answer only from the workspace snapshot below.\n"
                "If the snapshot is insufficient, say exactly what is missing.\n\n"
                f"User task:\n{job.prompt}\n\n"
                f"Workspace snapshot:\n{snapshot}\n"
            )

        self.store.append_log(
            job.id,
            "[system] Live workspace mode enabled: Codex may inspect the repository directly.",
        )
        return (
            "You are Codex running inside a browser-based VPS runner.\n"
            "You may inspect and edit files in the live workspace when necessary.\n"
            "Stay focused on the user's task, keep changes minimal and deliberate, and summarize what you changed.\n"
            "Do not assume browser state is persistent; job logs and final output are surfaced in a web UI.\n\n"
            f"User task:\n{job.prompt}\n"
        )

    def _run_codex(self, job: JobRecord, mode_spec: ModeSpec, prompt: str) -> None:
        self.store.append_log(job.id, f"[system] Launching: {shlex.join(mode_spec.command)}")

        process = subprocess.Popen(
            mode_spec.command,
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
        changed_files: set[str] = set()

        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            self.store.append_event(job.id, line)
            rendered = self._render_event(line, cwd=job.cwd)
            if rendered.log_line:
                self.store.append_log(job.id, rendered.log_line)
            if rendered.final_output:
                final_output = rendered.final_output
            if rendered.changed_files:
                changed_files.update(rendered.changed_files)

        return_code = process.wait()
        completed_job = self.store.get_job(job.id)
        completed_job.return_code = return_code
        completed_job.finished_at = utc_now()
        completed_job.updated_at = completed_job.finished_at
        completed_job.final_output = final_output
        completed_job.changed_files = sorted(changed_files)

        if return_code == 0:
            completed_job.status = JobStatus.succeeded
            completed_job.error = None
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

    def _render_event(self, raw_line: str, cwd: str) -> RenderedEvent:
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            if raw_line:
                return RenderedEvent(log_line=f"[raw] {raw_line}")
            return RenderedEvent()

        event_type = event.get("type")
        if event_type == "thread.started":
            return RenderedEvent(log_line=f"[system] Codex thread started: {event.get('thread_id')}")
        if event_type == "turn.started":
            return RenderedEvent(log_line="[system] Codex turn started")
        if event_type == "turn.completed":
            usage = event.get("usage") or {}
            return RenderedEvent(
                log_line=(
                    "[system] Codex turn completed "
                    f"(input={usage.get('input_tokens', 0)}, output={usage.get('output_tokens', 0)})"
                )
            )

        item = event.get("item") or {}
        item_type = item.get("type")
        if event_type == "item.started" and item_type == "file_change":
            count = len(item.get("changes") or [])
            return RenderedEvent(log_line=f"[files] Applying {count} file change(s)")

        if event_type != "item.completed":
            return RenderedEvent(log_line=f"[event] {event_type}")

        if item_type == "agent_message":
            text = (item.get("text") or "").strip()
            if not text:
                return RenderedEvent(log_line="[assistant] <empty response>")
            return RenderedEvent(log_line=f"[assistant]\n{text}", final_output=text)

        if item_type == "file_change":
            changes = item.get("changes") or []
            changed_files = tuple(self._display_path(change.get("path"), cwd) for change in changes if change.get("path"))
            if not changed_files:
                return RenderedEvent(log_line="[files] Completed file change")
            preview = ", ".join(changed_files[:4])
            if len(changed_files) > 4:
                preview += ", ..."
            return RenderedEvent(
                log_line=f"[files] Updated {len(changed_files)} file(s): {preview}",
                changed_files=changed_files,
            )

        if item_type == "mcp_tool_call":
            server = item.get("server") or "unknown"
            tool = item.get("tool") or "unknown"
            return RenderedEvent(log_line=f"[tool] {server}/{tool}")

        return RenderedEvent(log_line=f"[event] Completed {item_type}")

    def _display_path(self, raw_path: str, cwd: str) -> str:
        path = Path(raw_path)
        if not path.is_absolute():
            return raw_path
        try:
            return path.relative_to(Path(cwd)).as_posix()
        except ValueError:
            return raw_path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python -m backend.app.worker <job_id>", file=sys.stderr)
        return 2

    JobWorker().run(sys.argv[1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
