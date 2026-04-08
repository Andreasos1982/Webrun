# Project State Log

## 2026-04-08

### Summary

`webrun` is now a synced-thread-first Codex VPS runner.

The app no longer centers the browser UI on purely local chat sessions. New chats are started as native Codex threads, appear in synced history, and can be resumed from `webrun` against the same native thread.

### Current Working State

- FastAPI backend and React frontend are in place and build successfully
- Jobs persist under `data/jobs/<job_id>/`
- Each run stores:
  - `job.json`
  - `output.log`
  - `events.jsonl`
- Browser sessions can be closed without losing finished runs
- Synced Codex history is loaded through `codex app-server`
- New browser chats can continue synced Codex threads instead of creating local-only transcripts
- WebSocket streaming works with polling fallback
- Folder scope, model, reasoning effort, and access mode are persisted per run

### Important Host Constraint

This VPS still cannot use the native sandboxed Codex `workspace-write` path reliably.

Observed host failure:

`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

Practical consequence:

- `read-only` is the safest working mode
- live write support on this host currently uses `danger-full-access`

### Recent Product Changes

- synced Codex history is the main session source in the UI
- new chats are created as native synced Codex threads
- follow-up turns resume the same native thread when scope and mode are compatible
- native thread activity such as `compacting` is now surfaced in the UI instead of being hidden in raw events
- mobile scrolling was repaired
- mobile composer controls were compacted
- the current UI branch also contains pane/collapse work for the workspace console

### Known Gaps

- no browser-side `@path` or file attachment flow yet
- no browser diff/patch review surface yet
- no real cloud delegation mode yet
- native sandboxed `workspace-write` is still blocked on this VPS

### Operational Notes

- deployed user service: `webrun.service`
- public hostname: `dev.cs-automation.info`
- access is fronted by Nginx Proxy Manager
- local git history is the source of change tracking for this repo
