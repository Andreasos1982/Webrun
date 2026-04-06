# webrun

`webrun` is the actual product app: a browser-based Codex web runner for a VPS.

It is intentionally separate from the marketing site in `../lexmark`.

## Current State

The repo now contains:

- FastAPI backend in `backend/`
- React + Vite frontend in `frontend/`
- Detached disk-backed job workers
- Persistent chat-style sessions with alternating user / Codex messages
- Built frontend served by FastAPI for single-origin production deploys
- Persistent job metadata under `data/jobs/`
- Readable logs in `output.log`
- Raw Codex event capture in `events.jsonl`
- A VS-Code-like browser surface with session explorer, Codex chat thread, model picker, reasoning picker, access picker, logs, and raw events

## Codex-Style Session UX

The browser surface is now organized around a persistent session instead of a single one-off prompt:

- left sidebar for sessions
- main chat thread with alternating user and Codex messages
- composer controls for:
  - model
  - reasoning effort
  - access mode
- bottom panel for logs, raw events, and session details

Why this shape:

- it matches the core interaction style documented for the Codex IDE extension
- it lets you follow a conversation over multiple turns
- it keeps per-turn runner settings visible and persistent

## Job Modes

### `read-only`

- enabled by default
- backend builds a bounded workspace snapshot
- Codex runs with `--sandbox read-only`
- safest mode for repo inspection, summarization, and planning

### `workspace-write`

- live workspace mode
- disabled by default on this VPS
- can be enabled explicitly through `WORKSPACE_WRITE_STRATEGY`

Supported strategies:

- `disabled`
- `workspace-write`
- `danger-full-access`

Important VPS caveat:

On this host, the native Codex `workspace-write` sandbox currently fails with:

`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

That means the practical choices are:

- keep `workspace-write` disabled and use robust read-only mode
- or, for trusted internal use only, enable `WORKSPACE_WRITE_STRATEGY=danger-full-access`

## Requirements

- Python 3.10+
- Node.js 20+
- `codex` CLI installed and logged in on the VPS

Check the CLI:

```bash
codex --version
codex login
```

## Python Setup Notes For This VPS

This VPS can be awkward for Python packaging.

Preferred setup:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

If `python3 -m venv .venv` fails because `python3-venv` is missing:

```bash
sudo apt install python3-venv
```

If you must use the host Python without a venv, one fallback that worked on this box was:

```bash
~/.local/bin/pip install --user --break-system-packages -r backend/requirements.txt
```

## Frontend Setup

```bash
cd frontend
npm install
cd ..
```

## Running Locally

### 1. Start the backend

From the repo root:

```bash
source .venv/bin/activate
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Useful environment variables:

```bash
export WORKSPACE_ROOT=/home/andy/apps/webrun
export DATA_ROOT=/home/andy/apps/webrun/data
export CODEX_BIN=codex
export WORKSPACE_WRITE_STRATEGY=disabled
export CODEX_DEFAULT_MODEL=gpt-5.4
export CODEX_AVAILABLE_MODELS=gpt-5.4,gpt-5.3-codex,gpt-5.3-codex-spark
export CODEX_DEFAULT_REASONING_EFFORT=xhigh
```

Write strategy options:

```bash
export WORKSPACE_WRITE_STRATEGY=disabled
export WORKSPACE_WRITE_STRATEGY=workspace-write
export WORKSPACE_WRITE_STRATEGY=danger-full-access
```

Only use `danger-full-access` on a trusted internal box.

### 2. Start the frontend

```bash
cd frontend
npm run dev
```

Default URLs:

- frontend: `http://<host>:5173`
- backend API: `http://<host>:8000/api`

In dev, Vite proxies `/api` to `127.0.0.1:8000`, so the frontend can use the same-origin `/api` base that production uses.

## Production On This VPS

The production path on this host is now:

- build the frontend into `frontend/dist`
- serve both UI and API from FastAPI on the same origin
- run `webrun` as a user-level systemd service
- let Nginx Proxy Manager terminate TLS and apply access control

Configured values on this VPS:

- app service bind: `172.18.0.1:17800`
- NPM host: `dev.cs-automation.info`
- NPM access list: `AndymagAdmin`
- write strategy on this VPS: `danger-full-access`

### Service Files

- repo unit template: `deploy/systemd/webrun.service`
- installed user unit: `~/.config/systemd/user/webrun.service`
- helper wrapper: `scripts/webrun-service.sh`

### Service Commands

```bash
systemctl --user status webrun.service --no-pager
systemctl --user restart webrun.service
journalctl --user -u webrun.service -n 100 --no-pager
```

Important note:

`webrun.service` is a user service. On this VPS, linger has already been enabled for `andy`, so the service now auto-starts again after a cold reboot.

The wrapper script remains useful for manual fallback control:

```bash
./scripts/webrun-service.sh start
./scripts/webrun-service.sh stop
./scripts/webrun-service.sh status
```

### Reverse Proxy

The NPM proxy host forwards:

- `dev.cs-automation.info` -> `http://172.18.0.1:17800`

Current NPM settings:

- Let's Encrypt certificate enabled
- force SSL enabled
- HTTP/2 enabled
- `AndymagAdmin` access list attached

Important:

`workspace-write` is enabled on this VPS through `WORKSPACE_WRITE_STRATEGY=danger-full-access`, not through the native Codex `workspace-write` sandbox. That is the working option on this host because the native sandbox still fails here with the bubblewrap loopback error.

## Local Verification

### Frontend build

```bash
cd frontend
npm run build
```

### Backend syntax check

```bash
python3 -m compileall backend/app
```

### Backend/API smoke test

Start the backend first, then run:

```bash
python3 scripts/smoke_api.py
```

Optional examples:

```bash
python3 scripts/smoke_api.py --api-base http://127.0.0.1:8000/api
python3 scripts/smoke_api.py --mode read-only --prompt "Summarize the backend architecture."
python3 scripts/smoke_api.py --mode workspace-write --prompt "Add a small README note." --follow-up "Now summarize what you changed." --timeout 180
```

If `workspace-write` is disabled, the smoke script will fail fast with the API error message.

## API

- `GET /api/health`
- `GET /api/runtime`
- `GET /api/jobs`
- `POST /api/jobs`
- `POST /api/jobs/{job_id}/messages`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/status`
- `GET /api/jobs/{job_id}/logs?offset=0`
- `GET /api/jobs/{job_id}/events?offset=0`

## Job Storage

Each job lives under `data/jobs/<job_id>/`:

- `job.json`: persisted session metadata, current runner state, and full message history
- `output.log`: human-readable log stream for the browser output panel
- `events.jsonl`: raw Codex JSONL events

## Architecture Notes

- API requests create a job record first
- follow-up messages reuse the same disk-backed session record
- backend launches a detached worker process per turn
- worker owns the Codex subprocess and all job file writes
- browser disconnects do not stop jobs
- backend restarts no longer depend on an in-process thread to keep the run alive
- in production, the built frontend is served by the backend so UI and API share one origin

Additional notes live in [`docs/architecture.md`](docs/architecture.md).
