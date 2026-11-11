#!/usr/bin/env bash
# Copies one secret from services/agent/.env to the InstaCloud agent service (and to no other service), through
# stdin, so the value never reaches the screen, the shell history or a process list. Run it yourself, from anywhere:
#
#   scripts/instacloud/agent-secret.sh MCP_TOKEN
#
# `insta secrets set` redeploys the agent with the new value. KEEPER_PRIVATE_KEY makes that agent the keeper, so it is
# refused while this machine's agent still answers on 127.0.0.1:8787: one keeper key, one agent
# (docs/DEPLOY.md §7 "On InstaCloud").
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
name=${1:?usage: agent-secret.sh NAME (a variable in services/agent/.env)}

value=$(grep -m1 "^$name=" "$root/services/agent/.env" | cut -d= -f2- || true)
value=${value%\"}
value=${value#\"}
if [ -z "$value" ]; then
  echo "$name is not set in services/agent/.env" >&2
  exit 1
fi

if [ "$name" = KEEPER_PRIVATE_KEY ] && curl -s -o /dev/null --max-time 3 http://127.0.0.1:8787/health; then
  echo "this machine's agent still runs: pm2 delete mezodot-agent && pm2 save, then run this again" >&2
  exit 1
fi

# The repository root is the directory linked to the InstaCloud project (.insta/project.json).
cd "$root"
printf %s "$value" | insta secrets set "$name" --service compute/agent
