#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$RUN_DIR/webrun-supervisor.pid"
APP_LOG="$LOG_DIR/webrun-app.log"

HOST="${WEBRUN_HOST:-172.18.0.1}"
PORT="${WEBRUN_PORT:-17800}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
DATA_ROOT="${DATA_ROOT:-$ROOT_DIR/data}"
CODEX_BIN="${CODEX_BIN:-codex}"
WORKSPACE_WRITE_STRATEGY="${WORKSPACE_WRITE_STRATEGY:-danger-full-access}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

is_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  if [[ -z "$pid" ]]; then
    return 1
  fi

  kill -0 "$pid" 2>/dev/null
}

build_frontend() {
  (
    cd "$ROOT_DIR/frontend"
    npm run build
  )
}

run_forever() {
  local child_pid=""

  cleanup() {
    if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
      kill "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    exit 0
  }

  trap cleanup INT TERM

  export WORKSPACE_ROOT DATA_ROOT CODEX_BIN WORKSPACE_WRITE_STRATEGY

  while true; do
    echo "[$(date -Is)] starting webrun on ${HOST}:${PORT}"
    (
      cd "$ROOT_DIR"
      python3 -m uvicorn backend.app.main:app --host "$HOST" --port "$PORT"
    ) &
    child_pid="$!"
    echo "$$" > "$PID_FILE"

    set +e
    wait "$child_pid"
    local exit_code="$?"
    set -e

    child_pid=""
    echo "[$(date -Is)] uvicorn exited with status ${exit_code}, restarting in 2s"
    sleep 2
  done
}

start_service() {
  if is_running; then
    echo "webrun is already running (pid $(cat "$PID_FILE"))"
    return 0
  fi

  rm -f "$PID_FILE"
  build_frontend

  nohup "$0" run >>"$APP_LOG" 2>&1 &
  local supervisor_pid="$!"
  sleep 1

  if kill -0 "$supervisor_pid" 2>/dev/null; then
    echo "webrun started (supervisor pid ${supervisor_pid})"
    return 0
  fi

  echo "failed to start webrun, see $APP_LOG" >&2
  return 1
}

stop_service() {
  if ! is_running; then
    echo "webrun is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid"

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "webrun stopped"
      return 0
    fi
    sleep 0.5
  done

  echo "webrun did not stop cleanly" >&2
  return 1
}

status_service() {
  if is_running; then
    echo "webrun is running (pid $(cat "$PID_FILE")) on http://${HOST}:${PORT}"
    return 0
  fi

  echo "webrun is stopped"
  return 1
}

case "${1:-}" in
  run)
    run_forever
    ;;
  build)
    build_frontend
    ;;
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service || true
    start_service
    ;;
  status)
    status_service
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|build|run}" >&2
    exit 2
    ;;
esac
