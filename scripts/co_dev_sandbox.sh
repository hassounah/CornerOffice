#!/usr/bin/env bash
# Launch the headless Corner Office dev app inside a sandbox session (#0038, TRD §3.8).
#
#   scripts/co_dev_sandbox.sh [--wait | --stop]
#
#   (no flag)  run in the foreground
#   --wait     detach, write the pidfile, block until the app answers on CDP, print the banner
#   --stop     stop a detached or foreground run
#
# Knobs: PROFILE (default dev), DEBUG_PORT (default 9222), CORNER_OFFICE_CDP_PUBLISH_PORT (set by the host app).
# Never prints env values or secret files.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CO_REPO_ROOT:-$(cd "$HERE/.." && pwd)}"

# Plugin env audit (step 2.4). The installed corner-office plugin (v1.34.0, hooks, MCP and
# channel servers) reads no CORNER_OFFICE_* variables at all. It attributes activity to the
# host through paths only:
#   - ~/.corner-office/events/ (JSONL, written only when ~/.corner-office/events/enabled exists)
#   - ~/.claude/channels/ and ~/.claude/*.log (channel servers)
# Those are covered by the profile's own home (HOME-relative), not by env. The list below is
# therefore just the baseline; the real gate is S9.
#   CORNER_OFFICE_SANDBOX is deliberately kept (it marks the session as sandboxed).
HOST_ATTRIBUTION_ENV=(
  CORNER_OFFICE_CHANNEL_PORT
  CORNER_OFFICE_CDP_PUBLISH_PORT
)

# Keep equal to PROFILE_NAME_RE in src/main/services/app-home.ts (profile-name-regex.test.ts pins it).
PROFILE_RE='^[a-z0-9][a-z0-9-]{0,31}$'
DISPLAY_NUM=99
WAIT_SECONDS=90

PROFILE="${PROFILE:-dev}"
DEBUG_PORT="${DEBUG_PORT:-9222}"
HOME_DIR="$HOME/.corner-office/profiles/$PROFILE"
HOME_DISPLAY="~/.corner-office/profiles/$PROFILE"
PIDFILE="$HOME_DIR/dev-sandbox.pid"
CDP_FAILED="$HOME_DIR/cdp-publish.failed"
ROUTE_FILE="${CO_ROUTE_FILE:-/proc/net/route}"
LOG="$HOME_DIR/logs/dev-sandbox.log"

MODE=foreground
case "${1:-}" in
  '') ;;
  --wait) MODE=wait ;;
  --stop) MODE=stop ;;
  --run) MODE=run ;; # internal: the detached child of --wait
  *) echo "usage: co_dev_sandbox.sh [--wait | --stop]" >&2; exit 64 ;;
esac

# ── validation ────────────────────────────────────────────────────────────────
# [[ =~ ]] matches the whole string: a value with an embedded newline cannot slip past the anchors.
if ! [[ $PROFILE =~ $PROFILE_RE ]]; then
  echo "PROFILE=\"$PROFILE\" is invalid. Use 1-32 lowercase letters, digits or '-', starting with a letter or digit. Example: make dev-sandbox PROFILE=dev" >&2
  exit 2
fi
if ! [[ $DEBUG_PORT =~ ^[0-9]{1,5}$ ]] || [ "$DEBUG_PORT" -lt 1024 ] || [ "$DEBUG_PORT" -gt 65535 ]; then
  echo "DEBUG_PORT=\"$DEBUG_PORT\" is invalid. Use a port from 1024 to 65535. Example: make dev-sandbox DEBUG_PORT=9222" >&2
  exit 2
fi

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# The process group id of $1, read from /proc (no ps needed). Empty when unreadable.
pgid_of() {
  local stat rest pgrp
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 0
  rest="${stat##*) }" # skip "pid (comm) ", whose comm may contain spaces
  read -r _ _ pgrp _ <<<"$rest"
  printf '%s' "$pgrp"
}

# True only for a live process that really is this launcher: a pidfile can be stale or hand-edited,
# so never signal a pid just because it exists (pid 0 and 1 are refused outright).
launcher_alive() {
  local pid="${1:-}"
  [[ $pid =~ ^[0-9]+$ ]] && [ "$pid" -ge 2 ] && pid_alive "$pid" || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'co_dev_sandbox\.sh'
}

# ── --stop ────────────────────────────────────────────────────────────────────
stop_app() {
  if [ ! -f "$PIDFILE" ]; then
    echo "==> dev-sandbox is not running"
    return 0
  fi
  local pid group=0
  pid="$(head -n 1 "$PIDFILE")"
  if launcher_alive "$pid"; then
    # The detached run leads its own process group, and vite and electron stay in it, so one
    # group signal reaches everything (even the SIGKILL below, which skips the run's cleanup trap).
    [ "$(pgid_of "$pid")" = "$pid" ] && group=1
    signal_launcher() { if [ "$group" = 1 ]; then kill "-$1" -- "-$pid" 2>/dev/null || true; else kill "-$1" "$pid" 2>/dev/null || true; fi; }
    signal_launcher TERM
    for _ in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.5; done
    pid_alive "$pid" && signal_launcher KILL
  fi
  rm -f "$PIDFILE"
  echo "==> dev-sandbox stopped"
}

if [ "$MODE" = stop ]; then
  stop_app
  exit 0
fi

# Dev app access (3a): the host sets CORNER_OFFICE_CDP_PUBLISH_PORT when it published a port for this container.
# Refuse anything but a plain port (and the debug port itself), so the socat argv below is built only from validated values.
if [ -n "${CORNER_OFFICE_CDP_PUBLISH_PORT:-}" ]; then
  P="$CORNER_OFFICE_CDP_PUBLISH_PORT"
  if ! [[ $P =~ ^[0-9]{1,5}$ ]] || [ "$P" -lt 1024 ] || [ "$P" -gt 65535 ] || [ "$P" = "$DEBUG_PORT" ]; then
    echo "CORNER_OFFICE_CDP_PUBLISH_PORT=\"$P\" is invalid. It must be a port from 1024 to 65535 other than DEBUG_PORT; restart the session from Corner Office." >&2
    exit 2
  fi
fi

# ── preflight ─────────────────────────────────────────────────────────────────
ELECTRON_BIN="$REPO_ROOT/node_modules/electron/dist/electron"
PTY_NODE="$REPO_ROOT/node_modules/node-pty/build/Release/pty.node"

electron_present() { [ -e "$ELECTRON_BIN" ] && [ -e "$PTY_NODE" ]; }
electron_libs_missing() { [ -e "$ELECTRON_BIN" ] && ldd "$ELECTRON_BIN" 2>/dev/null | grep -q 'not found'; }

# Every mode that starts something refuses outside a sandbox session; --stop is harmless anywhere.
require_sandbox() {
  if [ "${CORNER_OFFICE_SANDBOX:-}" != 1 ]; then
    echo 'This target runs inside a Corner Office sandbox session. On the host use `make dev`.' >&2
    exit 2
  fi
}

preflight() {
  require_sandbox

  # Host-side problems, collected into ONE checklist so it can be relayed verbatim.
  local toolchain=0 allowlist=0
  if ! command -v Xvfb >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1 || electron_libs_missing; then toolchain=1; fi
  if ! electron_present; then
    if ! curl -s -o /dev/null --max-time 5 https://www.electronjs.org/ \
      || ! curl -s -o /dev/null --max-time 5 https://release-assets.githubusercontent.com/; then
      allowlist=1
    fi
  fi
  if [ "$toolchain" = 1 ] || [ "$allowlist" = 1 ]; then
    {
      echo "make dev-sandbox can't start yet. On the host, in Corner Office:"
      [ "$toolchain" = 1 ] && echo '  [ ] Settings > Sandbox > Toolchains: turn on "Electron dev runtime" and rebuild the image (affects all workspaces)'
      [ "$allowlist" = 1 ] && echo "  [ ] This workspace's sandbox settings > Allowlist: add electronjs.org"
      echo "  [ ] Restart this session"
    } >&2
    exit 3
  fi

  # Problems inside this container, reported separately.
  if [ -f "$PIDFILE" ] && launcher_alive "$(head -n 1 "$PIDFILE")"; then
    echo "dev-sandbox is already running (pid $(head -n 1 "$PIDFILE")); run make dev-sandbox-stop first" >&2
    exit 1
  fi
  if curl -s --max-time 2 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
    echo "port $DEBUG_PORT is in use; set DEBUG_PORT= to another port" >&2
    exit 1
  fi
  if [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]; then
    echo "display :$DISPLAY_NUM is in use; run make dev-sandbox-stop" >&2
    exit 1
  fi
}

# ── electron + profile ────────────────────────────────────────────────────────
ensure_electron() {
  electron_present && return 0
  echo "==> installing Electron (download + native rebuild, a few minutes)..." >&2
  (cd "$REPO_ROOT" && pnpm exec install-electron && make rebuild-native) >&2 \
    || { echo "installing Electron failed; see the output above" >&2; exit 1; }
  if electron_libs_missing; then
    {
      echo "make dev-sandbox can't start yet. On the host, in Corner Office:"
      echo '  [ ] Settings > Sandbox > Toolchains: turn on "Electron dev runtime" and rebuild the image (affects all workspaces)'
      echo "  [ ] Restart this session"
    } >&2
    exit 3
  fi
}

prepare_profile() {
  mkdir -p "$HOME_DIR/logs" "$HOME_DIR/shots" "$HOME_DIR/claude"
  rm -f "$CDP_FAILED"
  if [ ! -e "$HOME_DIR/claude/plugins" ] && [ ! -L "$HOME_DIR/claude/plugins" ]; then
    ln -s "$HOME/.claude/plugins" "$HOME_DIR/claude/plugins"
  fi
}

# ── Dev app access: the default gateway, fail closed ──────────────────────────
# Prints the default route's gateway from a /proc/net/route-format file as a dotted quad. Fails (no output) on an
# unreadable or empty file, no default route, a malformed or 0.0.0.0 gateway: then nothing is published.
parse_gw() {
  local file="$1" iface dest gw rest
  [ -r "$file" ] || return 1
  while read -r iface dest gw rest; do
    [ "$dest" = 00000000 ] || continue
    [[ $gw =~ ^[0-9A-Fa-f]{8}$ ]] || return 1
    local ip="$((16#${gw:6:2})).$((16#${gw:4:2})).$((16#${gw:2:2})).$((16#${gw:0:2}))"
    [ "$ip" != 0.0.0.0 ] || return 1
    printf '%s' "$ip"
    return 0
  done <"$file"
  return 1
}

# ── the banner (the host line is always present) ──────────────────────────────
print_banner() {
  local host_line="not published (Dev app access is off for this session)"
  if [ -n "${CORNER_OFFICE_CDP_PUBLISH_PORT:-}" ]; then
    if [ -e "$CDP_FAILED" ] || ! parse_gw "$ROUTE_FILE" >/dev/null; then
      host_line="not published (see the launcher log)"
    else
      host_line="127.0.0.1:$CORNER_OFFICE_CDP_PUBLISH_PORT"
    fi
  fi
  cat <<EOF
==> Corner Office dev profile "$PROFILE" (sandbox, headless Xvfb :$DISPLAY_NUM)
    cdp:  http://127.0.0.1:$DEBUG_PORT
    host: $host_line
    logs: $HOME_DISPLAY/logs/dev-sandbox.log (launcher+vite), $HOME_DISPLAY/logs/main.log (app)
    shot: node scripts/co_dev_shot.mjs [--text]
    stop: make dev-sandbox-stop
    note: these paths are inside the container and are lost when the sandbox is recreated.
EOF
}

# ── run: Xvfb, (socat), electron-vite ─────────────────────────────────────────
XVFB_PID=""
SOCAT_PID=""
VITE_PID=""

cleanup() {
  trap - EXIT INT TERM
  rm -f "$PIDFILE"
  if [ "$(pgid_of "$$")" = "$$" ]; then
    # The detached run leads its own group, and vite, electron, Xvfb and socat are all in it.
    trap '' TERM
    kill -TERM -- "-$$" 2>/dev/null || true
  else
    # Foreground run, sharing the user's group: stop only what this script started.
    [ -n "$VITE_PID" ] && { kill -TERM "$VITE_PID" 2>/dev/null || true; }
    [ -n "$SOCAT_PID" ] && { kill "$SOCAT_PID" 2>/dev/null || true; }
    [ -n "$XVFB_PID" ] && { kill "$XVFB_PID" 2>/dev/null || true; }
  fi
}

# Step 5: with Dev app access on, expose the dev app's CDP port to the host only, through socat limited to the gateway.
start_cdp_publish() {
  rm -f "$CDP_FAILED"
  [ -n "${CORNER_OFFICE_CDP_PUBLISH_PORT:-}" ] || return 0
  local gw
  if ! gw="$(parse_gw "$ROUTE_FILE")"; then
    echo "Dev app access: could not read the gateway from /proc/net/route; not publishing"
    touch "$CDP_FAILED"
    return 0
  fi
  socat "TCP-LISTEN:$CORNER_OFFICE_CDP_PUBLISH_PORT,bind=0.0.0.0,fork,reuseaddr,range=$gw/32" "TCP:127.0.0.1:$DEBUG_PORT" >>"$LOG" 2>&1 &
  SOCAT_PID=$!
  sleep 0.3
  if ! pid_alive "$SOCAT_PID"; then
    echo "Dev app access: socat exited at once; not publishing"
    SOCAT_PID=""
    touch "$CDP_FAILED"
  fi
}

run_app() {
  trap cleanup EXIT
  trap 'exit 143' INT TERM
  echo "$$" > "$PIDFILE"

  Xvfb ":$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp >>"$LOG" 2>&1 &
  XVFB_PID=$!
  export DISPLAY=":$DISPLAY_NUM"

  start_cdp_publish

  local strip=()
  for name in "${HOST_ATTRIBUTION_ENV[@]}"; do strip+=(-u "$name"); done
  # Same process group as this script: one group signal stops the whole tree (see cleanup and --stop).
  env "${strip[@]}" CORNER_OFFICE_PROFILE="$PROFILE" CORNER_OFFICE_DEBUG_PORT="$DEBUG_PORT" \
    "$REPO_ROOT/node_modules/.bin/electron-vite" dev --noSandbox -- --disable-gpu --disable-dev-shm-usage \
    >>"$LOG" 2>&1 &
  VITE_PID=$!
  wait "$VITE_PID"
}

wait_ready() {
  local pid="$1"
  echo "==> waiting for CDP on :$DEBUG_PORT (up to $WAIT_SECONDS s)..." >&2
  for _ in $(seq 1 "$WAIT_SECONDS"); do
    if ! pid_alive "$pid"; then
      echo "dev-sandbox exited before CDP came up. Last lines of $LOG:" >&2
      tail -n 30 "$LOG" >&2 || true
      echo "Full log: $LOG" >&2
      return 1
    fi
    if curl -s --max-time 2 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out after $WAIT_SECONDS s waiting for CDP. Last lines of $LOG:" >&2
  tail -n 30 "$LOG" >&2 || true
  echo "Full log: $LOG" >&2
  return 1
}

case "$MODE" in
  run)
    # Detached child of --wait: preflight and install already happened in the parent. Only --wait may start it.
    require_sandbox
    [ "${CO_DEV_SANDBOX_CHILD:-}" = 1 ] || { echo "--run is internal; use --wait" >&2; exit 64; }
    run_app
    ;;
  wait)
    preflight
    ensure_electron
    prepare_profile
    CO_DEV_SANDBOX_CHILD=1 setsid bash "$0" --run >>"$LOG" 2>&1 &
    child=$!
    if wait_ready "$child"; then
      print_banner
    else
      kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
      exit 1
    fi
    ;;
  foreground)
    preflight
    ensure_electron
    prepare_profile
    print_banner
    run_app
    ;;
esac
