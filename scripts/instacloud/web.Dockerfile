# The web app's image for InstaCloud (or any container host), built from the context `stage.sh web` writes: the
# production build in dist/, scripts/serve-web.ts as serve-web.mts, and instacloud.env (WEB_ALLOWED_HOSTS).
# The agent's URL is baked into the build (VITE_AGENT_URL), so a new agent URL needs a new stage and deploy.
#
# node:22-slim (Node 22.23.2) pinned by digest, the same as the agent; Node 22 runs the TypeScript server as is.
ARG NODE_IMAGE=node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_IMAGE}
ENV NODE_ENV=production WEB_HOST=0.0.0.0 WEB_PORT=8080 WEB_ROOT=/app/dist
WORKDIR /app
COPY serve-web.mts instacloud.env ./
COPY dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--env-file=instacloud.env", "serve-web.mts"]
