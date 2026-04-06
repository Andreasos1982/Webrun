#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from urllib import error, parse, request


def api_request(api_base: str, path: str, *, method: str = "GET", payload: dict | None = None) -> dict:
    body = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")

    req = request.Request(f"{api_base}{path}", data=body, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"detail": raw}
        detail = parsed.get("detail") or raw or f"HTTP {exc.code}"
        raise SystemExit(f"{method} {path} failed: {detail}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test the local webrun API.")
    parser.add_argument("--api-base", default="http://127.0.0.1:8000/api")
    parser.add_argument("--mode", choices=["read-only", "workspace-write"], default="read-only")
    parser.add_argument(
        "--prompt",
        default="Inspect this workspace in read-only mode and summarize what is already here.",
    )
    parser.add_argument(
        "--follow-up",
        default="Now answer in one short sentence what the main frontend surface is.",
    )
    parser.add_argument(
        "--extra-turn",
        action="append",
        default=[],
        help="Optional extra turn to append after the follow-up. Can be used multiple times, including slash commands like /status.",
    )
    parser.add_argument(
        "--open-folder",
        default=".",
        help="Workspace-relative folder to use as the open folder scope.",
    )
    parser.add_argument(
        "--limit-to-open-folder",
        action="store_true",
        help="Tell the runner to keep work scoped to the chosen open folder.",
    )
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()

    health = api_request(args.api_base, "/health")
    runtime = api_request(args.api_base, "/runtime")
    model = runtime["default_model"]
    reasoning_effort = runtime["default_reasoning_effort"]
    print(f"Health: {health['status']}")
    print(f"Workspace: {health['workspace_root']}")
    print(f"Write strategy: {runtime['workspace_write_strategy']}")
    print(f"Model: {model}")
    print(f"Reasoning: {reasoning_effort}")

    job = api_request(
        args.api_base,
        "/jobs",
        method="POST",
        payload={
            "prompt": args.prompt,
            "mode": args.mode,
            "model": model,
            "reasoning_effort": reasoning_effort,
            "open_folder": args.open_folder,
            "limit_to_open_folder": args.limit_to_open_folder,
        },
    )
    job_id = job["id"]
    print(f"Created session: {job_id} ({job['mode']})")

    def wait_for_completion() -> dict:
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            polled_job = api_request(args.api_base, f"/jobs/{parse.quote(job_id)}")
            print(f"Polling session {job_id}: {polled_job['status']} (turns={polled_job['turn_count']})")
            if polled_job["status"] in {"succeeded", "failed", "cancelled"}:
                return polled_job
            time.sleep(2)
        raise SystemExit(f"Timed out waiting for session {job_id} to finish.")

    job = wait_for_completion()

    if args.follow_up:
        follow_up_job = api_request(
            args.api_base,
            f"/jobs/{parse.quote(job_id)}/messages",
            method="POST",
            payload={
                "prompt": args.follow_up,
                "mode": args.mode,
                "model": model,
                "reasoning_effort": reasoning_effort,
                "open_folder": args.open_folder,
                "limit_to_open_folder": args.limit_to_open_folder,
            },
        )
        print(f"Queued follow-up turn: {follow_up_job['turn_count']}")
        job = wait_for_completion()

    for extra_turn in args.extra_turn:
        extra_turn_job = api_request(
            args.api_base,
            f"/jobs/{parse.quote(job_id)}/messages",
            method="POST",
            payload={
                "prompt": extra_turn,
                "mode": args.mode,
                "model": model,
                "reasoning_effort": reasoning_effort,
                "open_folder": args.open_folder,
                "limit_to_open_folder": args.limit_to_open_folder,
            },
        )
        print(f"Queued extra turn: {extra_turn_job['turn_count']} -> {extra_turn}")
        job = wait_for_completion()

    logs = api_request(args.api_base, f"/jobs/{parse.quote(job_id)}/logs?offset=0&limit=200000")
    events = api_request(args.api_base, f"/jobs/{parse.quote(job_id)}/events?offset=0&limit=200000")

    print("")
    print("Final status:", job["status"])
    print("Executor:", job["executor"])
    print("Worker PID:", job.get("worker_pid"))
    print("Return code:", job.get("return_code"))
    print("Thread ID:", job.get("thread_id"))
    print("Open folder:", job.get("open_folder"))
    print("Limit scope:", job.get("limit_to_open_folder"))
    print("Messages:", len(job.get("messages") or []))
    print("Turns:", job.get("turn_count"))
    if job.get("changed_files"):
        print("Changed files:", ", ".join(job["changed_files"]))
    if job.get("final_output"):
        print("")
        print("Latest assistant output:")
        print(job["final_output"])

    print("")
    print(f"Log bytes: {len(logs['chunk'])}")
    print(f"Event bytes: {len(events['chunk'])}")

    if job["status"] != "succeeded":
        print("", file=sys.stderr)
        print(job.get("error") or "Job failed.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
