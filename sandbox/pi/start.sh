#!/bin/sh
set -eu

pid_file=/sandbox/pi.pid
log_file=/sandbox/output/pi.log

if test -f "$pid_file"; then
  pid=$(cat "$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid"
    exit 0
  fi
  rm -f "$pid_file"
fi

nohup node /usr/local/lib/pi-orchestrator/client/daemon.mjs >>"$log_file" 2>&1 </dev/null &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
sleep 1

if ! kill -0 "$pid" 2>/dev/null; then
  tail -n 40 "$log_file" >&2 || true
  exit 1
fi

printf '%s\n' "$pid"
