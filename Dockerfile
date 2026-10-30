# Flowmator: one image for the main process, workers and webhook processes, like n8n's.
#   docker run -p 5678:5678 -v flowmator_data:/home/node/.flowmator flowmator
#   docker run ... flowmator worker      (queue mode)

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN npm install -g pnpm@9.15.9 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/workflow/package.json packages/workflow/
COPY packages/core/package.json packages/core/
COPY packages/nodes-base/package.json packages/nodes-base/
COPY packages/server/package.json packages/server/
COPY packages/editor/package.json packages/editor/

# ---- editor bundle ----
FROM base AS editor
RUN pnpm install --frozen-lockfile --filter @flowmator/editor...
COPY packages/workflow packages/workflow
COPY packages/editor packages/editor
RUN pnpm --filter @flowmator/editor build

# ---- server dependencies (the server runs its TypeScript sources through tsx) ----
FROM base AS server-deps
RUN pnpm install --frozen-lockfile --prod --filter @flowmator/server...

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim
# git + ssh for source control, tini to forward signals so executions stop gracefully
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini tzdata \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-deps /app /app
COPY packages/workflow packages/workflow
COPY packages/core packages/core
COPY packages/nodes-base packages/nodes-base
COPY packages/server packages/server
COPY --from=editor /app/packages/editor/dist packages/editor/dist
RUN ln -s /app/packages/server/bin/flowmator.mjs /usr/local/bin/flowmator \
  && chmod +x /app/packages/server/bin/flowmator.mjs \
  && mkdir -p /home/node/.flowmator && chown -R node:node /home/node/.flowmator

USER node
ENV NODE_ENV=production \
  N8N_PORT=5678
VOLUME /home/node/.flowmator
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.N8N_PORT || 5678) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["tini", "--", "flowmator"]
CMD ["start"]
