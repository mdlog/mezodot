# Build from the repository root:  docker build -f services/agent/Dockerfile -t mezodot-agent .
FROM node:22-slim
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY services/agent/package.json services/agent/
RUN pnpm install --frozen-lockfile --filter @mezodot/agent...
COPY packages/sdk packages/sdk
COPY services/agent services/agent
WORKDIR /app/services/agent
ENV HTTP_HOST=0.0.0.0 STATE_DIR=/data NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8787
CMD ["pnpm", "start"]
