# Web Runner

Minimal browser-based Codex runner for a VPS.

This MVP includes:

- A FastAPI backend in `backend/`
- A React + Vite frontend in `frontend/`
- Disk-backed local job storage under `data/jobs/`
- A first working read-only job flow

The current read-only flow works by building a bounded snapshot of the workspace on the backend and sending that snapshot to `codex exec` in JSON mode. That keeps the MVP practical and avoids exposing write access yet. The next step is adding a write-enabled executor that lets Codex operate directly on the workspace.

## Requirements

- Python 3.10+
- Node.js 20+
- `codex` CLI installed and logged in on the VPS

If `python3 -m venv .venv` fails on Debian or Ubuntu, install the missing system package first:

```bash
sudo apt install python3-venv
```

If you have not authenticated Codex on the box yet:

```bash
codex login
```

## Local Run

From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

Install the frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

Start the backend in one terminal:

```bash
source .venv/bin/activate
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

Start the frontend in a second terminal:

```bash
cd frontend
npm run dev
```

Open the app in your browser:

```text
http://<your-vps-ip>:5173
```

The frontend will call the backend at:

```text
http://<your-vps-ip>:8000/api
```

## API Endpoints

- `POST /api/jobs` creates a job
- `GET /api/jobs` lists jobs
- `GET /api/jobs/{job_id}` returns full job metadata
- `GET /api/jobs/{job_id}/status` returns status-only job state
- `GET /api/jobs/{job_id}/logs?offset=0` returns append-only log output

## Job Storage

Each job is stored under `data/jobs/<job_id>/`:

- `job.json` for job metadata and status
- `output.log` for the readable log panel
- `events.jsonl` for raw Codex JSONL events

## Current Scope

- Read-only jobs only
- No auth layer yet
- No streaming websockets yet
- No write-enabled Codex execution yet
