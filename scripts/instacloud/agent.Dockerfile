# The agent's image for InstaCloud (or any container host), built from the context `stage.sh agent` writes: the
# self-contained bundle (no node_modules) and instacloud.env, the non-secret settings. Secrets such as
# KEEPER_PRIVATE_KEY, MCP_TOKEN or PYTH_API_KEY come from the host's environment, which wins over the file. Without
# KEEPER_PRIVATE_KEY the agent is read-only: it serves the web app's API but sends no transaction.
#
# node:22-slim (Node 22.23.2) pinned by digest, the same as services/agent/Dockerfile; bump both together.
ARG NODE_IMAGE=node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_IMAGE}
ENV NODE_ENV=production HTTP_HOST=0.0.0.0 HTTP_PORT=8787 STATE_DIR=/data
WORKDIR /app
COPY agent.mjs agent.mjs.map mcp-stdio.mjs mcp-stdio.mjs.map instacloud.env ./
RUN mkdir -p /data && chown node:node /data
EXPOSE 8787
# The platform mounts its volume over /data, owned by root: hand it to the unprivileged user, then exec node as that
# user, so node is the process that receives SIGTERM and the agent's graceful shutdown runs.
CMD ["sh", "-c", "if [ \"$(id -u)\" = 0 ]; then chown node:node /data && exec setpriv --reuid=node --regid=node --init-groups node --enable-source-maps --env-file=instacloud.env agent.mjs; else exec node --enable-source-maps --env-file=instacloud.env agent.mjs; fi"]
