from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import select
import subprocess
import time
from typing import Any, Callable

from fastapi import HTTPException

from ..config import Settings


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_timestamp(value: Any) -> str | None:
    if value is None:
        return None

    if isinstance(value, (int, float)):
        timestamp = float(value)
    else:
        raw = str(value).strip()
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            try:
                timestamp = float(raw)
            except ValueError:
                return None
        else:
            return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


class CodexAppServerError(RuntimeError):
    pass


class CodexAppServerClient:
    def __init__(self, settings: Settings, timeout_seconds: float = 12.0) -> None:
        self.settings = settings
        self.timeout_seconds = timeout_seconds
        self._next_request_id = 0
        self._process: subprocess.Popen[str] | None = None

    def __enter__(self) -> CodexAppServerClient:
        self._process = subprocess.Popen(
            [self.settings.codex_bin, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "webrun",
                    "version": "0.1.0",
                },
                "capabilities": {
                    "experimentalApi": True,
                    "optOutNotificationMethods": [],
                },
            },
        )
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def close(self) -> None:
        if self._process is None:
            return

        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=2)

        self._process = None

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self.send_request(method, params)
        return self.wait_for_response(request_id)

    def send_request(self, method: str, params: dict[str, Any]) -> int:
        process = self._require_process()
        request_id = self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }

        if process.stdin is None:
            raise CodexAppServerError("Codex history transport did not open stdin.")
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()
        return request_id

    @property
    def process(self) -> subprocess.Popen[str]:
        return self._require_process()

    def read_message(self, timeout_seconds: float | None = None) -> dict[str, Any] | None:
        process = self._require_process()
        if process.stdout is None:
            raise CodexAppServerError("Codex history transport did not open stdout.")

        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        readable, _, _ = select.select([process.stdout], [], [], timeout)
        if not readable:
            return None

        raw_line = process.stdout.readline()
        if not raw_line:
            raise CodexAppServerError("Codex history transport exited unexpectedly.")

        try:
            return json.loads(raw_line)
        except json.JSONDecodeError:
            return None

    def wait_for_response(
        self,
        request_id: int,
        *,
        timeout_seconds: float | None = None,
        on_message: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + (timeout_seconds or self.timeout_seconds)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CodexAppServerError("Codex history request timed out.")

            message = self.read_message(timeout_seconds=remaining)
            if message is None:
                continue

            if on_message is not None:
                on_message(message)

            if message.get("id") != request_id:
                continue

            return self._extract_result(request_id, message)

    def _require_process(self) -> subprocess.Popen[str]:
        if self._process is None:
            raise CodexAppServerError("Codex history transport is not running.")
        return self._process

    def _next_id(self) -> int:
        self._next_request_id += 1
        return self._next_request_id

    def _extract_result(self, request_id: int, message: dict[str, Any]) -> dict[str, Any]:
        if "error" in message:
            error = message["error"]
            if isinstance(error, dict):
                detail = _normalize_text(error.get("message"))
            else:
                detail = _normalize_text(error)
            raise CodexAppServerError(detail or f"Codex history request {request_id} failed.")

        result = message.get("result")
        if not isinstance(result, dict):
            raise CodexAppServerError("Codex history transport returned an invalid payload.")
        return result


class CodexHistoryService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def list_threads(
        self,
        *,
        limit: int = 40,
        cursor: str | None = None,
        search_term: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "limit": limit,
            "sortKey": "updated_at",
            "sourceKinds": ["vscode", "cli", "appServer"],
        }
        if cursor:
            params["cursor"] = cursor
        if search_term:
            params["searchTerm"] = search_term

        result = self._request("thread/list", params)
        raw_threads = result.get("data")
        if not isinstance(raw_threads, list):
            raise HTTPException(status_code=502, detail="Codex history returned an invalid thread list.")

        threads = [self._serialize_thread_summary(thread) for thread in raw_threads if isinstance(thread, dict)]
        return {
            "threads": threads,
            "next_cursor": _normalize_text(result.get("nextCursor")),
        }

    def read_thread(self, thread_id: str) -> dict[str, Any]:
        clean_thread_id = thread_id.strip()
        if not clean_thread_id:
            raise HTTPException(status_code=400, detail="Thread id cannot be empty.")

        result = self._request(
            "thread/read",
            {
                "threadId": clean_thread_id,
                "includeTurns": True,
            },
        )
        raw_thread = result.get("thread")
        if not isinstance(raw_thread, dict):
            raise HTTPException(status_code=502, detail="Codex history returned an invalid thread payload.")

        return {
            "thread": self._serialize_thread_summary(raw_thread),
            "messages": self._serialize_messages(raw_thread),
        }

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            with CodexAppServerClient(self.settings) as client:
                return client.request(method, params)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail="Configured Codex binary was not found on this host.") from exc
        except CodexAppServerError as exc:
            detail = str(exc).strip() or "Codex history request failed."
            if "not found" in detail.lower():
                raise HTTPException(status_code=404, detail=detail) from exc
            raise HTTPException(status_code=502, detail=detail) from exc

    def _serialize_thread_summary(self, thread: dict[str, Any]) -> dict[str, Any]:
        name = _normalize_text(thread.get("name"))
        preview = _normalize_text(thread.get("preview")) or ""
        path = _normalize_text(thread.get("path")) or ""
        return {
            "id": _normalize_text(thread.get("id")) or "",
            "name": name or self._derive_thread_name(preview=preview, path=path),
            "preview": preview,
            "created_at": _normalize_timestamp(thread.get("createdAt")),
            "updated_at": _normalize_timestamp(thread.get("updatedAt")),
            "status": self._normalize_status(thread.get("status")),
            "source": _normalize_text(thread.get("source")) or "unknown",
            "cwd": _normalize_text(thread.get("cwd")) or "",
            "model_provider": _normalize_text(thread.get("modelProvider")),
            "cli_version": _normalize_text(thread.get("cliVersion")),
            "path": path,
        }

    def _serialize_messages(self, thread: dict[str, Any]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        turns = thread.get("turns")
        if not isinstance(turns, list):
            return messages

        for turn_index, turn in enumerate(turns, start=1):
            if not isinstance(turn, dict):
                continue

            turn_id = _normalize_text(turn.get("id")) or f"turn-{turn_index}"
            turn_status = _normalize_text(turn.get("status"))
            turn_error = _normalize_text(turn.get("error"))
            items = turn.get("items")
            assistant_message_seen = False

            if isinstance(items, list):
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    item_type = _normalize_text(item.get("type")) or "unknown"
                    item_id = _normalize_text(item.get("id")) or f"{turn_id}-{len(messages) + 1}"

                    if item_type == "userMessage":
                        content = self._render_user_message(item.get("content"))
                        if content:
                            messages.append(
                                {
                                    "id": item_id,
                                    "role": "user",
                                    "content": content,
                                    "turn_id": turn_id,
                                    "turn_index": turn_index,
                                    "phase": None,
                                    "source_item_type": item_type,
                                }
                            )
                        continue

                    if item_type == "agentMessage":
                        assistant_message_seen = True
                        content = _normalize_text(item.get("text"))
                        if content:
                            messages.append(
                                {
                                    "id": item_id,
                                    "role": "assistant",
                                    "content": content,
                                    "turn_id": turn_id,
                                    "turn_index": turn_index,
                                    "phase": _normalize_text(item.get("phase")),
                                    "source_item_type": item_type,
                                }
                            )

            if turn_error and not assistant_message_seen:
                messages.append(
                    {
                        "id": f"{turn_id}-error",
                        "role": "assistant",
                        "content": turn_error,
                        "turn_id": turn_id,
                        "turn_index": turn_index,
                        "phase": turn_status or "error",
                        "source_item_type": "turnError",
                    }
                )

        return messages

    def _render_user_message(self, content: Any) -> str:
        if not isinstance(content, list):
            return ""

        chunks: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = _normalize_text(item.get("type")) or "unknown"

            if item_type == "text":
                text = _normalize_text(item.get("text"))
                if text:
                    chunks.append(text)
                continue

            if item_type in {"mention", "local_image", "image"}:
                label = (
                    _normalize_text(item.get("path"))
                    or _normalize_text(item.get("name"))
                    or _normalize_text(item.get("image_url"))
                    or item_type
                )
                chunks.append(f"[{item_type}: {label}]")
                continue

            label = _normalize_text(item.get("path")) or _normalize_text(item.get("name")) or item_type
            chunks.append(f"[{item_type}: {label}]")

        return "\n".join(chunk for chunk in chunks if chunk).strip()

    def _derive_thread_name(self, *, preview: str, path: str) -> str:
        if preview:
            single_line = " ".join(preview.split())
            if len(single_line) <= 72:
                return single_line
            return f"{single_line[:69]}..."

        if path:
            return Path(path).stem or "Codex thread"

        return "Codex thread"

    def _normalize_status(self, value: Any) -> str:
        if isinstance(value, dict):
            status_type = _normalize_text(value.get("type"))
            if status_type:
                return status_type
        return _normalize_text(value) or "unknown"
