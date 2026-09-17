#!/bin/sh
# Xvfb chooses a free display; stale locks from a stopped container cannot block boot.
set -eu
DISPLAY_FILE=$(mktemp /tmp/openbot-display.XXXXXX)
xpid= vpid= wpid= app=
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$app" ]; then kill -TERM "$app" 2>/dev/null || true; wait "$app" 2>/dev/null || true; fi
  for pid in "$vpid" "$wpid" "$xpid"; do
    if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  rm -f "$DISPLAY_FILE"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
Xvfb -displayfd 3 -screen 0 1440x900x24 -nolisten tcp 3>"$DISPLAY_FILE" &
xpid=$!
tries=0
while [ ! -s "$DISPLAY_FILE" ]; do
  kill -0 "$xpid" 2>/dev/null || { echo 'Xvfb failed to start' >&2; exit 1; }
  tries=$((tries + 1))
  [ "$tries" -lt 50 ] || { echo 'Xvfb startup deadline exceeded' >&2; exit 1; }
  sleep 0.1
done
export DISPLAY=":$(cat "$DISPLAY_FILE")"
x11vnc -display "$DISPLAY" -passwd "$VNC_PASSWORD" -forever -shared -localhost -rfbport 5900 -quiet &
vpid=$!
websockify --web /usr/share/novnc 0.0.0.0:6080 localhost:5900 &
wpid=$!
bun src/index.ts &
app=$!
# If a dependency dies, stop the application and let Docker's restart policy recover the stack.
while kill -0 "$app" 2>/dev/null; do
  for pid in "$xpid" "$vpid" "$wpid"; do
    kill -0 "$pid" 2>/dev/null || { echo 'Computer display dependency exited' >&2; exit 1; }
  done
  sleep 1
done
wait "$app"
