# AGENTS.md

## Scope

This repository is the `webrun` product app only.

Do not work on `../lexmark` from this repo workflow.

## Product Summary

`webrun` is a browser-based Codex runner for a VPS.

Current shape:

- FastAPI backend in `backend/app`
- React + Vite frontend in `frontend`
- disk-backed run metadata in `data/jobs`
- native synced Codex threads via `codex app-server`
- WebSocket job streaming with polling fallback

## Repo Map

- `backend/app`: API, worker, runner, storage, mode registry
- `frontend/src`: main UI and styling
- `data/jobs`: persisted per-run job metadata, logs, raw events
- `deploy/systemd`: service template
- `docs`: architecture and state docs
- `scripts`: smoke checks and service helpers

## Working Rules

- Keep changes incremental. Do not rewrite the app from scratch.
- Preserve working flows unless the task explicitly replaces them.
- Use local git only. Do not push to GitHub from this repo workflow.
- Prefer pragmatic file-backed persistence over new infrastructure.
- Keep `Synced Threads` as the primary chat surface. `data/jobs` is runner metadata, not the main user-facing source of truth.

## Runtime Facts

- Production entrypoint is the user service `webrun.service`
- Public hostname is `dev.cs-automation.info`
- The VPS currently runs with `WORKSPACE_WRITE_STRATEGY=danger-full-access`
- Native sandboxed `workspace-write` is still blocked on this host by the bubblewrap loopback error

## Verification Defaults

When changing backend behavior:

- `python3 -m compileall backend/app`

When changing frontend behavior:

- `cd frontend && npm run build`

When changing the deployed app behavior on this VPS:

- `systemctl --user restart webrun.service`
- `systemctl --user is-active webrun.service`

## Documentation Hygiene

- Update `README.md` when setup, deployment, or user-visible behavior changes
- Update `docs/project_state_log.md` when architecture, runner behavior, or deployment state changes materially
