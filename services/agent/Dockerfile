# Build from the repository root:  docker build -f services/agent/Dockerfile -t mezodot-agent .
# (docker compose builds it on every `up`: the image bakes in packages/sdk's deployment JSON and ABIs.)
#
# node:22-slim (Node 22.23.2) pinned by digest; bump it deliberately.
ARG NODE_IMAGE=node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# --- build: install the workspace, bundle the agent and the stdio MCP server --------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY services/agent/package.json services/agent/
RUN pnpm install --frozen-lockfile --filter @mezodot/agent...
COPY packages/sdk packages/sdk
COPY services/agent services/agent
RUN pnpm --filter @mezodot/agent bundle

# --- runtime: Node and two self-contained files; no node_modules, no dev tooling, unprivileged user --------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production HTTP_HOST=0.0.0.0 STATE_DIR=/data
WORKDIR /app
COPY --from=build /app/services/agent/dist/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
# 200 while healthy, 503 when a critical check fails (loops stalled, oracle unusable, keeper out of gas, stuck
# relays): see GET /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# node is the main process (no npm/pnpm wrapper), so SIGTERM reaches the agent's graceful shutdown.
CMD ["node", "--enable-source-maps", "agent.mjs"]
# MCP over stdio from the image:  docker run --rm -i --env-file services/agent/.env mezodot-agent node mcp-stdio.mjs
