#!/usr/bin/env bash
# Stops the local devnet anvils started by start.sh.
STATE="$(cd "$(dirname "$0")/../.." && pwd)/.devnet"
for name in hub spoke; do
  if [ -f "$STATE/$name.pid" ]; then kill "$(cat "$STATE/$name.pid")" 2>/dev/null || true; rm -f "$STATE/$name.pid"; fi
done
