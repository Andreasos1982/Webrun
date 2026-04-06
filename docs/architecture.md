# Webrun Architecture

## Current MVP

`webrun` is the actual product repo for a browser-based Codex runner on a VPS.

Current working pieces:

- FastAPI backend under `backend/app`
- React + Vite frontend under `frontend`
- Disk-backed jobs under `data/jobs/<job_id>/`
- Read-only Codex job flow using a bounded workspace snapshot
- Polling UI for jobs and `output.log`

Current job artifacts:

- `job.json`: persisted metadata and final result
- `output.log`: human-readable runner log
- `events.jsonl`: raw Codex JSONL event stream

## What The MVP Does Well

- Jobs persist to disk instead of browser memory
- The frontend can be closed and reopened without losing finished jobs
- The read-only snapshot flow is already useful for repo inspection and summarization
- The codebase is still small enough to evolve without a rewrite

## Main Gaps Found

- Job execution is started from an in-process backend thread, so backend restarts can orphan running work
- Only `read-only` jobs are actually enabled
- Logs, raw events, and final output are not surfaced as clearly separated browser views
- The API does not currently expose runtime capabilities or mode availability
- `docs/architecture.md` and `README.md` did not describe the real VPS caveats yet

## VPS Constraint That Matters

The Codex CLI on this host supports both `read-only` and `workspace-write` modes in principle, but the native sandboxed write path currently fails here with:

`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

That means:

- snapshot-backed `read-only` is safe and works now
- native sandboxed `workspace-write` is not reliable on this VPS as-is
- a live write runner is still technically possible by using Codex with `--dangerously-bypass-approvals-and-sandbox`, but that should remain an explicit, guarded opt-in for trusted internal use only

## Implementation Direction

### 1. Detached Job Workers

Move job execution out of backend threads into detached worker processes:

- API creates a job record on disk
- backend launches a separate Python worker process for that job
- worker owns the Codex subprocess, log writes, raw events, and final status
- browser disconnects do not matter
- backend restarts no longer cancel active jobs

### 2. Explicit Job Modes

Introduce a mode registry with runtime capability reporting:

- `read-only`: enabled by default, snapshot-backed
- `workspace-write`: live workspace access, disabled unless the host strategy explicitly enables it

Write strategy should be environment-driven:

- `disabled`
- `workspace-write` when the native sandbox works on a host
- `danger-full-access` for guarded internal use on hosts where the native sandbox is unavailable

### 3. Better UI Information Architecture

Move the browser UX closer to a lightweight VS Code / agent console:

- job/session sidebar
- central prompt/task composer
- bottom panel tabs for logs, raw events, and final response
- clear per-job mode and status badges
- runtime capability messaging when write mode is unavailable

### 4. Pragmatic Local DX

Keep the stack simple:

- keep file-backed persistence
- avoid introducing databases or queues right now
- document exact local/VPS commands
- add a small smoke script for backend/API verification

## Scope For This Iteration

The next implementation pass should deliver:

1. Detached persistent workers instead of in-process threads
2. Robust read-only flow preserved
3. Guarded architecture for live write jobs
4. Cleaner API for runtime info, logs, and raw events
5. VS-Code-like frontend improvements
6. Updated README plus a local smoke-test helper
