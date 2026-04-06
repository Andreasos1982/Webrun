from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
from typing import Literal

from .config import get_settings
from .models import ConversationMessage, JobRecord, JobStatus, MessageRole
from .services.modes import (
    ModeSpec,
    build_exec_command,
    build_resume_command,
    build_review_command,
    get_mode_spec,
    supports_native_resume,
)
from .services.snapshot import WorkspaceSnapshotBuilder
from .services.storage import JobStore, utc_now


@dataclass(frozen=True)
class RenderedEvent:
    log_line: str | None = None
    final_output: str | None = None
    changed_files: tuple[str, ...] = field(default_factory=tuple)
    thread_id: str | None = None


@dataclass(frozen=True)
class ParsedTurn:
    kind: Literal["chat", "review", "status", "local", "cloud"]
    prompt: str


class JobWorker:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.store = JobStore(self.settings.jobs_root)
        self._active_process: subprocess.Popen[str] | None = None
        self._cancel_requested = False
        self._current_job_id: str | None = None

    def run(self, job_id: str) -> None:
        self._current_job_id = job_id
        self._install_signal_handlers()

        job = self.store.get_job(job_id)
        mode_spec = get_mode_spec(self.settings, job.mode)
        current_turn = job.turn_count

        if job.cancel_requested_at:
            self._mark_cancelled(job, "Cancellation was requested before the turn started.")
            return

        if not mode_spec.enabled:
            self._fail_job(job, mode_spec.reason or f"Job mode {job.mode.value} is not available.")
            return

        latest_user_message = next((message for message in reversed(job.messages) if message.role == MessageRole.user), None)
        if latest_user_message is None:
            self._fail_job(job, "No user message was found for this turn.")
            return

        parsed_turn = self._parse_turn(latest_user_message.content)
        should_resume = self._should_resume_natively(job, mode_spec, parsed_turn.kind)

        if parsed_turn.kind == "status":
            self._complete_status_turn(job, current_turn=current_turn)
            return

        if parsed_turn.kind in {"local", "cloud"}:
            self._complete_route_turn(job, current_turn=current_turn, route=parsed_turn.kind)
            return

        command = self._build_command(job, parsed_turn, should_resume)
        if not command:
            self._fail_job(job, "Unable to prepare a Codex command for this turn on this host.")
            return

        executor = self._executor_name(mode_spec, parsed_turn.kind, should_resume)

        job.status = JobStatus.running
        job.executor = executor
        job.command = command
        job.worker_pid = os.getpid()
        job.started_at = utc_now()
        job.finished_at = None
        job.error = None
        job.return_code = None
        job.updated_at = job.started_at
        self.store.save_job(job)

        self.store.append_log(job.id, f"[system] Session {job.id} turn {current_turn} accepted")
        self.store.append_log(job.id, f"[system] Mode: {job.mode.value}")
        self.store.append_log(job.id, f"[system] Model: {job.model}")
        self.store.append_log(job.id, f"[system] Reasoning: {job.reasoning_effort.value}")
        self.store.append_log(job.id, f"[system] Open folder: {job.open_folder}")
        self.store.append_log(job.id, f"[system] Workspace: {job.cwd}")
        self.store.append_log(job.id, f"[system] Worker PID: {job.worker_pid}")
        self.store.append_log(job.id, f"[system] Executor: {executor}")
        if mode_spec.dangerous:
            self.store.append_log(
                job.id,
                "[warning] Live write mode is running without the native Codex sandbox on this host.",
            )
        if should_resume and job.thread_id:
            self.store.append_log(job.id, f"[system] Resuming native Codex thread: {job.thread_id}")
        elif job.thread_id:
            self.store.append_log(
                job.id,
                "[system] Starting a fresh Codex thread because the workspace scope or mode changed.",
            )
        self.store.append_log(job.id, f"[user] {latest_user_message.content}")

        try:
            prompt = self._build_prompt(job, mode_spec, parsed_turn, should_resume)
            self._run_codex(
                job,
                prompt,
                current_turn=current_turn,
                allow_thread_update=parsed_turn.kind == "chat" and not should_resume,
            )
        except FileNotFoundError:
            self._fail_job(job, "The `codex` CLI was not found on this machine.")
        except Exception as exc:  # noqa: BLE001
            self._fail_job(job, f"Job failed unexpectedly: {exc}")

    def _install_signal_handlers(self) -> None:
        signal.signal(signal.SIGTERM, self._handle_cancel_signal)
        signal.signal(signal.SIGINT, self._handle_cancel_signal)

    def _handle_cancel_signal(self, signum: int, _frame: object) -> None:
        self._cancel_requested = True
        if self._current_job_id:
            self.store.append_log(self._current_job_id, f"[system] Cancellation signal received ({signum})")
        if self._active_process and self._active_process.poll() is None:
            self._active_process.terminate()

    def _parse_turn(self, content: str) -> ParsedTurn:
        stripped = content.strip()
        if not stripped.startswith("/"):
            return ParsedTurn(kind="chat", prompt=stripped)

        command, _, remainder = stripped.partition(" ")
        payload = remainder.strip()

        if command == "/status":
            return ParsedTurn(kind="status", prompt=payload)
        if command == "/local":
            return ParsedTurn(kind="local", prompt=payload)
        if command == "/cloud":
            return ParsedTurn(kind="cloud", prompt=payload)
        if command == "/review":
            return ParsedTurn(kind="review", prompt=payload or "Review the current changes and report the key findings.")
        return ParsedTurn(kind="chat", prompt=stripped)

    def _should_resume_natively(self, job: JobRecord, mode_spec: ModeSpec, turn_kind: str) -> bool:
        if turn_kind != "chat":
            return False
        if not job.thread_id:
            return False
        if job.thread_mode and job.thread_mode != job.mode:
            return False
        if job.thread_cwd and job.thread_cwd != job.cwd:
            return False
        if job.thread_open_folder and job.thread_open_folder != job.open_folder:
            return False
        if (
            job.thread_limit_to_open_folder is not None
            and job.thread_limit_to_open_folder != job.limit_to_open_folder
        ):
            return False
        return supports_native_resume(self.settings, mode_spec.mode)

    def _build_command(self, job: JobRecord, parsed_turn: ParsedTurn, should_resume: bool) -> list[str]:
        if parsed_turn.kind == "status":
            return []
        if parsed_turn.kind in {"local", "cloud"}:
            return []
        if parsed_turn.kind == "review":
            return build_review_command(
                self.settings,
                job.mode,
                model=job.model,
                reasoning_effort=job.reasoning_effort,
            )
        if should_resume and job.thread_id:
            resume_command = build_resume_command(
                self.settings,
                job.mode,
                model=job.model,
                reasoning_effort=job.reasoning_effort,
                thread_id=job.thread_id,
            )
            if resume_command:
                return resume_command
        return build_exec_command(
            self.settings,
            job.mode,
            model=job.model,
            reasoning_effort=job.reasoning_effort,
        )

    def _executor_name(self, mode_spec: ModeSpec, turn_kind: str, should_resume: bool) -> str:
        if turn_kind == "review":
            return "codex-review"
        if turn_kind in {"local", "cloud"}:
            return f"session-{turn_kind}"
        if should_resume:
            return f"{mode_spec.executor}-resume"
        return mode_spec.executor

    def _build_prompt(self, job: JobRecord, mode_spec: ModeSpec, parsed_turn: ParsedTurn, should_resume: bool) -> str:
        latest_request = parsed_turn.prompt
        transcript = self._render_transcript(job)
        open_folder_line = f"Open folder: {job.open_folder} ({job.cwd})"
        folder_guardrail = ""
        if job.limit_to_open_folder:
            folder_guardrail = (
                "Treat the open folder as the only allowed work area. "
                "Do not read or write outside it unless the user explicitly changes scope.\n"
            )

        if parsed_turn.kind == "review":
            return (
                f"{open_folder_line}\n"
                f"{folder_guardrail}"
                "Focus on behavioral regressions, risks, and missing tests. Keep findings first.\n\n"
                f"Custom review instructions:\n{latest_request}\n"
            )

        if mode_spec.launch_strategy == "snapshot":
            snapshot = WorkspaceSnapshotBuilder(Path(job.cwd)).build(latest_request)
            self.store.append_log(job.id, "[system] Built bounded workspace snapshot")
            self.store.append_log(job.id, f"[system] Snapshot characters: {len(snapshot)}")
            if should_resume:
                return (
                    "Continue the existing Codex session.\n"
                    "This turn remains strict read-only.\n"
                    f"{open_folder_line}\n"
                    "Use only the snapshot below.\n\n"
                    f"User request:\n{latest_request}\n\n"
                    f"Workspace snapshot:\n{snapshot}\n"
                )
            return (
                "You are Codex running inside a browser-based VPS runner.\n"
                "You are continuing a chat-style coding conversation.\n"
                "You are in strict read-only mode for this turn.\n"
                "Do not call shell tools, MCP tools, or web search.\n"
                "Answer only from the workspace snapshot below and the conversation transcript.\n"
                "If the snapshot is insufficient, say exactly what is missing.\n\n"
                f"{open_folder_line}\n\n"
                f"Session transcript:\n{transcript}\n\n"
                f"Workspace snapshot:\n{snapshot}\n"
            )

        self.store.append_log(
            job.id,
            "[system] Live workspace mode enabled: Codex may inspect the repository directly.",
        )
        if should_resume:
            return (
                "Continue the existing Codex session.\n"
                f"{open_folder_line}\n"
                f"{folder_guardrail}"
                f"User request:\n{latest_request}\n"
            )
        return (
            "You are Codex running inside a browser-based VPS runner.\n"
            "You are continuing a chat-style coding conversation.\n"
            "You may inspect and edit files in the live workspace when necessary.\n"
            "Stay focused on the user's latest request, keep changes minimal and deliberate, and summarize what you changed.\n"
            "Do not assume browser state is persistent; job logs and final output are surfaced in a web UI.\n\n"
            f"{open_folder_line}\n"
            f"{folder_guardrail}\n"
            f"Session transcript:\n{transcript}\n"
        )

    def _run_codex(
        self,
        job: JobRecord,
        prompt: str,
        current_turn: int,
        allow_thread_update: bool,
    ) -> None:
        self.store.append_log(job.id, f"[system] Launching: {shlex.join(job.command)}")

        process = subprocess.Popen(
            job.command,
            cwd=job.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._active_process = process

        assert process.stdin is not None
        process.stdin.write(prompt)
        process.stdin.close()

        final_output: str | None = None
        changed_files: set[str] = set()
        thread_id: str | None = None

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
            if rendered.thread_id:
                thread_id = rendered.thread_id

        return_code = process.wait()
        self._active_process = None

        completed_job = self.store.get_job(job.id)
        completed_job.return_code = return_code
        completed_job.finished_at = utc_now()
        completed_job.updated_at = completed_job.finished_at
        completed_job.final_output = final_output
        completed_job.changed_files = sorted(changed_files)

        if self._cancel_requested or completed_job.cancel_requested_at:
            completed_job.status = JobStatus.cancelled
            completed_job.error = None
            self.store.append_log(job.id, "[system] Turn cancelled")
            self.store.save_job(completed_job)
            return

        if allow_thread_update:
            completed_job.thread_id = thread_id or completed_job.thread_id
            completed_job.thread_mode = completed_job.mode
            completed_job.thread_cwd = completed_job.cwd
            completed_job.thread_open_folder = completed_job.open_folder
            completed_job.thread_limit_to_open_folder = completed_job.limit_to_open_folder

        if return_code == 0:
            completed_job.status = JobStatus.succeeded
            completed_job.error = None
            if final_output and not self._turn_has_assistant_message(completed_job, current_turn):
                completed_job.messages.append(
                    ConversationMessage(
                        id=os.urandom(8).hex(),
                        role=MessageRole.assistant,
                        content=final_output,
                        created_at=completed_job.finished_at,
                        turn=current_turn,
                        mode=completed_job.mode,
                        model=completed_job.model,
                        reasoning_effort=completed_job.reasoning_effort,
                    )
                )
            self.store.append_log(job.id, "[system] Job finished successfully")
        else:
            completed_job.status = JobStatus.failed
            completed_job.error = f"Codex exited with status {return_code}."
            self.store.append_log(job.id, f"[error] {completed_job.error}")

        self.store.save_job(completed_job)

    def _complete_status_turn(self, job: JobRecord, current_turn: int) -> None:
        latest_output = job.final_output or "No assistant output has been recorded yet."
        summary = (
            f"Session `{job.id}` is currently using `{job.model}` with `{job.reasoning_effort.value}` reasoning in "
            f"`{job.mode.value}` mode. Open folder: `{job.open_folder}`. "
            f"Native thread: `{job.thread_id or 'not started yet'}`. "
            f"Previous executor: `{job.executor}`. Last output: {latest_output}"
        )

        completed_job = self.store.get_job(job.id)
        completed_job.status = JobStatus.succeeded
        completed_job.executor = "session-status"
        completed_job.command = []
        completed_job.worker_pid = os.getpid()
        completed_job.started_at = utc_now()
        completed_job.finished_at = completed_job.started_at
        completed_job.updated_at = completed_job.started_at
        completed_job.final_output = summary
        completed_job.return_code = 0
        completed_job.error = None
        completed_job.messages.append(
            ConversationMessage(
                id=os.urandom(8).hex(),
                role=MessageRole.assistant,
                content=summary,
                created_at=completed_job.finished_at,
                turn=current_turn,
                mode=completed_job.mode,
                model=completed_job.model,
                reasoning_effort=completed_job.reasoning_effort,
            )
        )
        self.store.save_job(completed_job)
        self.store.append_log(job.id, "[system] Rendered synthetic /status response")

    def _complete_route_turn(self, job: JobRecord, current_turn: int, route: Literal["local", "cloud"]) -> None:
        if route == "local":
            summary = (
                "WebRun already executes locally on this VPS. "
                f"The current session stays in `{job.mode.value}` mode with open folder `{job.open_folder}`."
            )
        else:
            summary = (
                "Cloud delegation is not implemented in WebRun yet. "
                "Stay on the local VPS runner for now, or add a cloud-backed execution path as a future mode."
            )

        completed_job = self.store.get_job(job.id)
        completed_job.status = JobStatus.succeeded
        completed_job.executor = f"session-{route}"
        completed_job.command = []
        completed_job.worker_pid = os.getpid()
        completed_job.started_at = utc_now()
        completed_job.finished_at = completed_job.started_at
        completed_job.updated_at = completed_job.started_at
        completed_job.final_output = summary
        completed_job.return_code = 0
        completed_job.error = None
        completed_job.messages.append(
            ConversationMessage(
                id=os.urandom(8).hex(),
                role=MessageRole.assistant,
                content=summary,
                created_at=completed_job.finished_at,
                turn=current_turn,
                mode=completed_job.mode,
                model=completed_job.model,
                reasoning_effort=completed_job.reasoning_effort,
            )
        )
        self.store.save_job(completed_job)
        self.store.append_log(job.id, f"[system] Rendered synthetic /{route} response")

    def _mark_cancelled(self, job: JobRecord, message: str) -> None:
        cancelled_job = self.store.get_job(job.id)
        cancelled_job.status = JobStatus.cancelled
        cancelled_job.error = None
        cancelled_job.finished_at = utc_now()
        cancelled_job.updated_at = cancelled_job.finished_at
        cancelled_job.return_code = None
        self.store.save_job(cancelled_job)
        self.store.append_log(job.id, f"[system] {message}")

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
            stripped = raw_line.strip()
            if not stripped:
                return RenderedEvent()
            if "failed to warm featured plugin ids cache" in raw_line:
                return RenderedEvent(
                    log_line="[warning] Codex plugin cache refresh was denied upstream; continuing without it."
                )
            if "shell_snapshot" in raw_line:
                return RenderedEvent(log_line="[warning] Codex shell snapshot cleanup warning.")
            if stripped.startswith("<") and stripped.endswith(">"):
                return RenderedEvent()
            return RenderedEvent(log_line=f"[raw] {raw_line}")

        event_type = event.get("type")
        if event_type == "thread.started":
            return RenderedEvent(
                log_line=f"[system] Codex thread started: {event.get('thread_id')}",
                thread_id=event.get("thread_id"),
            )
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

    def _render_transcript(self, job: JobRecord) -> str:
        blocks: list[str] = []
        for message in job.messages:
            speaker = "User" if message.role == MessageRole.user else "Codex"
            meta_parts = [f"turn {message.turn}"]
            if message.model:
                meta_parts.append(message.model)
            if message.reasoning_effort:
                meta_parts.append(message.reasoning_effort.value)
            if message.mode:
                meta_parts.append(message.mode.value)
            blocks.append(f"{speaker} ({', '.join(meta_parts)}):\n{message.content.strip()}")
        return "\n\n".join(blocks)

    def _turn_has_assistant_message(self, job: JobRecord, turn: int) -> bool:
        return any(message.role == MessageRole.assistant and message.turn == turn for message in job.messages)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python -m backend.app.worker <job_id>", file=sys.stderr)
        return 2

    JobWorker().run(sys.argv[1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
