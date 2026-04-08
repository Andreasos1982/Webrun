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
- the assistant response style in `webrun` was tuned to be clearer and less terse
- the workspace UI now includes pane/collapse work for the workspace console

### Local Git State

Recent local commits include:

- `372ba7b feat: surface native codex compaction state`
- `ee064b8 feat: tune webrun assistant response style`
- `310ee99 docs: add agent guide and project state log`
- `a59d1f7 feat: add scroll panes to mobile chat layout`
- `bbc79f7 fix: align mobile composer status row`
- `f1f8918 fix: compact mobile composer controls`
- `99ecc91 fix: restore mobile scrolling`
- `311b772 feat: sync webrun chats with codex history`

### GitHub Push Status

- SSH authentication to GitHub works on this VPS for `Andreasos1982/CWB`
- no git remote is configured in this repo yet
- `git@github.com:Andreasos1982/webrun.git` does not exist yet
- there is currently no GitHub API token or `gh` CLI login on the VPS, so repo creation cannot be completed automatically from this host alone

### Export Preparation

- the repo work is fully committed locally up through `372ba7b feat: surface native codex compaction state`
- the local project log now tracks product changes, deployment state, and the GitHub export blocker
- local runtime noise such as `error.log` is ignored so future commits stay focused on source changes

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
