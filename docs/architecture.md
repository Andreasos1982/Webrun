# Webrun Architecture

## Current Product Shape

`webrun` is the actual product repo for a browser-based Codex runner on a VPS.

Current working pieces:

- FastAPI backend under `backend/app`
- React + Vite frontend under `frontend`
- Disk-backed sessions under `data/jobs/<job_id>/`
- Detached worker process per turn
- Chat-style session history with alternating user / Codex messages
- Native Codex thread ids persisted per session when a turn starts a fresh thread
- Read-only Codex job flow using a bounded workspace snapshot
- Live workspace turns when the host strategy enables them
- WebSocket streaming for the selected session, with polling fallback
- Folder-scoped session execution with `open_folder` and `limit_to_open_folder`
- Synthetic slash turns for `/status`, `/local`, and `/cloud`, plus Codex `/review`

Current job artifacts:

- `job.json`: persisted session metadata, current turn state, and full message history
- `output.log`: human-readable runner log
- `events.jsonl`: raw Codex JSONL event stream

## What The Current Architecture Does Well

- Jobs persist to disk instead of browser memory
- The frontend can be closed and reopened without losing finished jobs
- Multi-turn chat sessions can be resumed in the browser because the transcript is stored server-side
- Compatible follow-up turns can resume the native Codex thread instead of replaying the whole transcript
- The read-only snapshot flow is useful for repo inspection and summarization
- Model, reasoning effort, and access mode are persisted with each turn
- Folder scope is persisted with each turn and used as a native-resume guardrail
- The codebase is still small enough to evolve without a rewrite

## Remaining Gaps

- Native sandboxed `workspace-write` is still blocked on this VPS
- There is still no browser-side diff preview or file/tag attachment flow like `@path`
- Running turns cannot yet queue the next turn before the current one completes
- Cloud delegation is still not implemented as a real execution mode

## VPS Constraint That Matters

The Codex CLI on this host supports both `read-only` and `workspace-write` modes in principle, but the native sandboxed write path currently fails here with:

`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

That means:

- snapshot-backed `read-only` is safe and works now
- native sandboxed `workspace-write` is not reliable on this VPS as-is
- a live write runner is still technically possible by using Codex with `--dangerously-bypass-approvals-and-sandbox`, but that should remain an explicit, guarded opt-in for trusted internal use only

## Implementation Direction

### 1. Disk-Backed Chat Sessions

Keep the browser UX centered on a persistent session:

- each session lives under `data/jobs/<job_id>/`
- `job.json` contains message history and the latest runner configuration
- `job.json` also stores the native thread id plus the scope that thread was established under
- new user messages append a new turn to the same session
- the browser can reopen later and rebuild the full conversation from disk

### 2. Detached Turn Workers

Run each turn in a separate worker process:

- API appends the user message first
- backend launches a detached Python worker for the new turn
- the worker owns the Codex subprocess, logs, raw events, and final assistant message
- the worker also owns synthetic slash-command turns and cancellation handling
- browser disconnects do not matter
- backend restarts no longer cancel active turns

### 3. Explicit Job Modes

Introduce a mode registry with runtime capability reporting:

- `read-only`: enabled by default, snapshot-backed
- `workspace-write`: live workspace access, disabled unless the host strategy explicitly enables it

Write strategy should be environment-driven:

- `disabled`
- `workspace-write` when the native sandbox works on a host
- `danger-full-access` for guarded internal use on hosts where the native sandbox is unavailable

### 4. Better UI Information Architecture

Move the browser UX closer to a lightweight VS Code / agent console:

- session sidebar
- central workspace console
- right-side Codex chat thread
- composer controls for model, reasoning effort, access mode, and folder scope
- lower panel for logs, raw events, and session details
- clear per-session mode and status badges
- quick slash-command buttons
- live updates over WebSocket

### 5. Pragmatic Local DX

Keep the stack simple:

- keep file-backed persistence
- avoid introducing databases or queues right now
- document exact local/VPS commands
- add a small smoke script for backend/API verification

## Scope For This Iteration

The next implementation pass should deliver:

1. Browser-side file/context attachment like the Codex IDE `@path` flow
2. Queueing follow-ups while a turn is still running
3. Native sandboxed `workspace-write` on hosts that can support it
4. Richer job types such as dedicated test/build/review presets
