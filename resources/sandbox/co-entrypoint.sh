#!/bin/bash
# Idle main process. It starts on every `docker start`, BEFORE init-firewall.sh, so it must never
# resolve a command through the agent-writable ~/.local/bin (C1).
PATH=/usr/bin:/bin
export PATH
# docker stop → docker-init forwards TERM here → forward to all agent processes
# (claude runs its SessionEnd hooks, which remove its channel card), then exit.
trap 'kill -TERM -1 2>/dev/null; /usr/bin/sleep 3; exit 0' TERM INT
while true; do /usr/bin/sleep 86400 & wait $!; done
