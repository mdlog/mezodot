#!/usr/bin/env bash
# Stages a self-contained build context for one InstaCloud compute service in .insta-stage/<service>, then deploy it
# from the repository root (the directory linked to the InstaCloud project):
#
#   AGENT_HOST=<agent's domain> scripts/instacloud/stage.sh agent
#   insta deploy .insta-stage/agent --group agent --port 8787
#
#   AGENT_URL=https://<agent's domain> WEB_HOST=<web's domain> scripts/instacloud/stage.sh web
#   insta deploy .insta-stage/web --group web --port 8080
#
# Staging keeps the upload small and free of anything private: the agent goes up as its bundle and the web app as its
# build, never the repository (no .env, no keystore, no node_modules). Only non-secret settings are written here;
# secrets go in with `insta secrets set` by whoever holds them.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
service=${1:?usage: stage.sh agent|web}
out="$root/.insta-stage/$service"

case "$service" in
  agent)
    : "${AGENT_HOST:?AGENT_HOST must be the domain of the agent service (insta service list)}"
    pnpm --dir "$root" --filter @mezodot/agent bundle
    rm -rf "$out"
    mkdir -p "$out"
    cp "$root"/services/agent/dist/agent.mjs* "$root"/services/agent/dist/mcp-stdio.mjs* "$out"/
    cp "$root/scripts/instacloud/agent.Dockerfile" "$out/Dockerfile"
    # Public RPCs only, two per spoke: viem's default Sepolia RPC rate-limits a polling agent.
    cat > "$out/instacloud.env" <<EOF
MEZODOT_ENV=${MEZODOT_ENV:-testnet}
AGENT_MODULES=${AGENT_MODULES:-relayer,liquidator,risk,http,oracle}
POLL_MS=${POLL_MS:-6000}
ORACLE_WATCH_MS=${ORACLE_WATCH_MS:-30000}
HTTP_ALLOWED_HOSTS=$AGENT_HOST
MCP_ALLOWED_HOSTS=$AGENT_HOST
MCP_ALLOW_WRITE=false
RPC_ETH_SEPOLIA=${RPC_ETH_SEPOLIA:-https://sepolia.gateway.tenderly.co,https://ethereum-sepolia-rpc.publicnode.com}
RPC_BASE_SEPOLIA=${RPC_BASE_SEPOLIA:-https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com}
EOF
    ;;
  web)
    : "${AGENT_URL:?AGENT_URL must be the https URL of the agent}"
    : "${WEB_HOST:?WEB_HOST must be the domain of the web service (insta service list)}"
    rm -rf "$out"
    mkdir -p "$out"
    # A separate outDir: apps/web/dist is what this machine's own server (pm2 mezodot-web) serves.
    # Variables already in the environment win over apps/web/.env*.
    VITE_AGENT_URL="$AGENT_URL" VITE_WALLETCONNECT_PROJECT_ID="${VITE_WALLETCONNECT_PROJECT_ID:-none}" \
      pnpm --dir "$root" --filter @mezodot/web exec vite build --outDir "$out/dist" --emptyOutDir
    cp "$root/scripts/serve-web.ts" "$out/serve-web.mts"
    cp "$root/scripts/instacloud/web.Dockerfile" "$out/Dockerfile"
    printf 'WEB_ALLOWED_HOSTS=%s\n' "$WEB_HOST" > "$out/instacloud.env"
    ;;
  *)
    echo "usage: stage.sh agent|web" >&2
    exit 2
    ;;
esac

# Docker semantics for the upload (insta honours a root .dockerignore), so no .gitignore above can drop dist/.
printf '.env\n.env.*\n' > "$out/.dockerignore"
echo "staged $out"
