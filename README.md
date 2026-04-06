# webrun

`webrun` is the actual product app: a browser-based Codex web runner for a VPS.

It is intentionally separate from the marketing site in `../lexmark`.

## Current State

The repo now contains:

- FastAPI backend in `backend/`
- React + Vite frontend in `frontend/`
- Detached disk-backed job workers
- Persistent job metadata under `data/jobs/`
- Readable logs in `output.log`
- Raw Codex event capture in `events.jsonl`
- A VS-Code-like browser surface with job explorer, task composer, response panel, logs, and raw events

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
python3 scripts/smoke_api.py --mode workspace-write --prompt "Add a small README note." --timeout 180
```

If `workspace-write` is disabled, the smoke script will fail fast with the API error message.

## API

- `GET /api/health`
- `GET /api/runtime`
- `GET /api/jobs`
- `POST /api/jobs`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/status`
- `GET /api/jobs/{job_id}/logs?offset=0`
- `GET /api/jobs/{job_id}/events?offset=0`

## Job Storage

Each job lives under `data/jobs/<job_id>/`:

- `job.json`: persisted job metadata and final result
- `output.log`: human-readable log stream for the browser output panel
- `events.jsonl`: raw Codex JSONL events

## Architecture Notes

- API requests create a job record first
- backend launches a detached worker process per job
- worker owns the Codex subprocess and all job file writes
- browser disconnects do not stop jobs
- backend restarts no longer depend on an in-process thread to keep the run alive

Additional notes live in [`docs/architecture.md`](docs/architecture.md).
