#!/usr/bin/env bash
# Launch the headless Corner Office dev app inside a sandbox session (#0038, TRD §3.8).
# Normally run through make: `make dev` (= --wait) and `make dev-stop` (= --stop).
#
#   scripts/co_dev_sandbox.sh --wait | --stop
#
#   --wait     detach, write the pidfile, block until the app answers on CDP, print the banner
#   --stop     stop a detached run
#
# Fixed profile "dev", CDP on 127.0.0.1:9222. Never prints env values or secret files.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CO_REPO_ROOT:-$(cd "$HERE/.." && pwd)}"

# Plugin env audit (step 2.4). The installed corner-office plugin (v1.34.0, hooks, MCP and
# channel servers) reads no CORNER_OFFICE_* variables at all. It attributes activity to the
# host through paths only:
#   - ~/.corner-office/events/ (JSONL, written only when ~/.corner-office/events/enabled exists)
#   - ~/.claude/channels/ and ~/.claude/*.log (channel servers)
# Those paths are HOME-relative, and a nested session started from the dev app keeps the container
# HOME (only the app's own data lives in the profile home), so nested sessions can appear in the host
# app. Accepted risk: dev mode in the sandbox is an internal testing tool. S9 only reports what it sees.
# The list below is therefore just the baseline.
#   CORNER_OFFICE_SANDBOX is deliberately kept (it marks the session as sandboxed).
HOST_ATTRIBUTION_ENV=(
  CORNER_OFFICE_CHANNEL_PORT
)

# System packages the Electron dev runtime needs (Wolfi names), for sandbox.extraPackages in config.json.
ELECTRON_PACKAGES=(
  xvfb glib libnss libnspr libatk-1.0 libatk-bridge-2.0 at-spi2-core cups-libs dbus-libs libdrm libxkbcommon libxcomposite
  libxdamage libxfixes libxrandr mesa-gbm pango cairo alsa-lib gtk-3 fontconfig ttf-dejavu libudev xkbcomp
)

PROFILE=dev
DEBUG_PORT=9222
DISPLAY_NUM=99
X_LOCK="${CO_X_LOCK:-/tmp/.X$DISPLAY_NUM-lock}"
X_SOCKET="${CO_X_SOCKET:-/tmp/.X11-unix/X$DISPLAY_NUM}"
X_NAME="${CO_X_NAME:-Xvfb}"
# The glibc loader lists a binary's missing libraries; the image has no ldd.
LDSO="${CO_LDSO:-/lib/ld-linux-x86-64.so.2}"
WAIT_SECONDS=90

HOME_DIR="$HOME/.corner-office/profiles/$PROFILE"
HOME_DISPLAY="~/.corner-office/profiles/$PROFILE"
PIDFILE="$HOME_DIR/dev-sandbox.pid"
LOG="$HOME_DIR/logs/dev-sandbox.log"

case "${1:-}" in
  --wait) MODE=wait ;;
  --stop) MODE=stop ;;
  --run) MODE=run ;; # internal: the detached child of --wait
  *) echo "usage: co_dev_sandbox.sh --wait | --stop (normally: make dev, make dev-stop)" >&2; exit 64 ;;
esac

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

# The display counts as in use only while the pid in its Xvfb lock is a live Xvfb. A lock or socket
# left behind by a killed Xvfb is removed; pids restart after a container restart, so a live pid that
# is not Xvfb counts as stale too. Prints the live pid and fails when the display is really in use.
clear_stale_display() {
  local pid=""
  [ -f "$X_LOCK" ] && pid="$(tr -d ' \n' <"$X_LOCK" 2>/dev/null || true)"
  if [[ $pid =~ ^[0-9]+$ ]] && pid_alive "$pid" && [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = "$X_NAME" ]; then
    printf '%s' "$pid"
    return 1
  fi
  rm -f "$X_LOCK" "$X_SOCKET"
}

# ── --stop ────────────────────────────────────────────────────────────────────
stop_app() {
  if [ ! -f "$PIDFILE" ]; then
    echo "==> the headless dev app is not running"
    clear_stale_display >/dev/null || true
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
  clear_stale_display >/dev/null || true
  echo "==> the headless dev app stopped"
}

if [ "$MODE" = stop ]; then
  stop_app
  exit 0
fi

# ── preflight ─────────────────────────────────────────────────────────────────
ELECTRON_BIN="$REPO_ROOT/node_modules/electron/dist/electron"
PTY_NODE="$REPO_ROOT/node_modules/node-pty/build/Release/pty.node"

electron_present() { [ -e "$ELECTRON_BIN" ] && [ -e "$PTY_NODE" ]; }
electron_libs_missing() { [ -e "$ELECTRON_BIN" ] && ! "$LDSO" --list "$ELECTRON_BIN" >/dev/null 2>&1; }

# Every mode that starts something refuses outside a sandbox session; --stop is harmless anywhere.
require_sandbox() {
  if [ "${CORNER_OFFICE_SANDBOX:-}" != 1 ]; then
    echo 'make dev outside a sandbox session runs the windowed app; this launcher is for inside a sandbox.' >&2
    exit 2
  fi
}

# The ELECTRON_PACKAGES list as a JSON array, e.g. ["xvfb", "glib"].
packages_json() {
  local out="" p
  for p in "${ELECTRON_PACKAGES[@]}"; do out+="${out:+, }\"$p\""; done
  printf '[%s]' "$out"
}

# The host checklist, printed once with only the lines that apply, then exit 3. $1: toolchain 0|1, $2: allowlist 0|1.
print_checklist() {
  {
    echo "make dev can't start the headless app yet. On the host:"
    if [ "$1" = 1 ]; then
      echo '  [ ] Add these to "sandbox" in ~/.corner-office/config.json (quit Corner Office first), then Settings > Sandbox > Image: Rebuild:'
      echo "      \"extraPackages\": $(packages_json)"
    fi
    [ "$2" = 1 ] && echo "  [ ] This workspace's sandbox allowlist: add electronjs.org and release-assets.githubusercontent.com"
    echo "  [ ] Restart this session"
  } >&2
  exit 3
}

preflight() {
  require_sandbox

  # Host-side problems, collected into ONE checklist so it can be relayed verbatim.
  local toolchain=0 allowlist=0
  # Xvfb runs xkbcomp for its keymap and dies without it, but the xvfb package does not pull it in.
  if ! command -v Xvfb >/dev/null 2>&1 || ! command -v xkbcomp >/dev/null 2>&1 || electron_libs_missing; then
    toolchain=1
  fi
  if ! electron_present; then
    if ! curl -s -o /dev/null --max-time 5 https://artifacts.electronjs.org/ \
      || ! curl -s -o /dev/null --max-time 5 https://release-assets.githubusercontent.com/; then
      allowlist=1
    fi
  fi
  if [ "$toolchain" = 1 ] || [ "$allowlist" = 1 ]; then
    print_checklist "$toolchain" "$allowlist"
  fi

  # Problems inside this container, reported separately.
  if [ -f "$PIDFILE" ] && launcher_alive "$(head -n 1 "$PIDFILE")"; then
    echo "the headless dev app is already running (pid $(head -n 1 "$PIDFILE")); run make dev-stop first" >&2
    exit 1
  fi
  if curl -s --max-time 2 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
    echo "port $DEBUG_PORT is in use" >&2
    exit 1
  fi
  local x_pid
  if ! x_pid="$(clear_stale_display)"; then
    echo "display :$DISPLAY_NUM is in use by pid $x_pid; run make dev-stop" >&2
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
    print_checklist 1 0
  fi
}

prepare_profile() {
  mkdir -p "$HOME_DIR/logs" "$HOME_DIR/shots" "$HOME_DIR/claude"
  if [ ! -e "$HOME_DIR/claude/plugins" ] && [ ! -L "$HOME_DIR/claude/plugins" ]; then
    ln -s "$HOME/.claude/plugins" "$HOME_DIR/claude/plugins"
  fi
}

print_banner() {
  cat <<EOF
==> Corner Office dev profile "$PROFILE" (sandbox, headless Xvfb :$DISPLAY_NUM)
    cdp:  http://127.0.0.1:$DEBUG_PORT
    logs: $HOME_DISPLAY/logs/dev-sandbox.log (launcher+vite), $HOME_DISPLAY/logs/main.log (app)
    shot: node scripts/co_dev_shot.mjs [--text]
    stop: make dev-stop
    note: these paths are inside the container and are lost when the sandbox is recreated.
EOF
}

# ── run: Xvfb, electron-vite ──────────────────────────────────────────────────
XVFB_PID=""

cleanup() {
  trap - EXIT INT TERM
  rm -f "$PIDFILE"
  # The detached run leads its own group, and vite, electron and Xvfb are all in it.
  trap '' TERM
  kill -TERM -- "-$$" 2>/dev/null || true
}

run_app() {
  trap cleanup EXIT
  trap 'exit 143' INT TERM
  echo "$$" > "$PIDFILE"

  Xvfb ":$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp >>"$LOG" 2>&1 &
  XVFB_PID=$!
  export DISPLAY=":$DISPLAY_NUM"

  local strip=()
  for name in "${HOST_ATTRIBUTION_ENV[@]}"; do strip+=(-u "$name"); done
  # Same process group as this script: one group signal stops the whole tree (see cleanup and --stop).
  env "${strip[@]}" CORNER_OFFICE_PROFILE="$PROFILE" CORNER_OFFICE_DEBUG_PORT="$DEBUG_PORT" \
    "$REPO_ROOT/node_modules/.bin/electron-vite" dev --noSandbox -- --disable-gpu --disable-dev-shm-usage \
    >>"$LOG" 2>&1 &
  wait "$!"
}

wait_ready() {
  local pid="$1"
  echo "==> waiting for CDP on :$DEBUG_PORT (up to $WAIT_SECONDS s)..." >&2
  for _ in $(seq 1 "$WAIT_SECONDS"); do
    if ! pid_alive "$pid"; then
      echo "the headless dev app exited before CDP came up. Last lines of $LOG:" >&2
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
esac
