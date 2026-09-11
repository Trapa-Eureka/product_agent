# TASK-930 (AUD-015): the reproducible artifact. One image runs the REST API
# (and can run the MCP server: `node --import tsx apps/mcp-server/src/main.ts`).
# Everything is pinned by the lockfile and the pnpm version in package.json,
# built from a clean checkout, and run as a non-root user with the data
# directory on a volume. The console is a static build served by a host or
# proxy that applies the headers in ARCHITECTURE.md §6 (docs/DEPLOYMENT.md).
#
#   docker build -t production-change-agent .
#   docker run --rm -p 3000:3000 -e PCA_DEMO_MODE=true -e PCA_STORAGE=memory production-change-agent
#
# No service beyond the image is needed for the demo; a deployment sets the
# variables listed in docs/DEPLOYMENT.md instead of PCA_DEMO_MODE.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Fetch the pinned pnpm now, so no stage — and no running container — needs
# the network to find it later.
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /app

FROM base AS deps
# Only the manifests first, so the dependency layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/web/package.json apps/web/
COPY packages/application/package.json packages/application/
COPY packages/bootstrap/package.json packages/bootstrap/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/fixtures/package.json packages/fixtures/
COPY packages/realtime-client/package.json packages/realtime-client/
COPY packages/test-support/package.json packages/test-support/
COPY packages/adapters/file-store/package.json packages/adapters/file-store/
COPY packages/adapters/local-auth/package.json packages/adapters/local-auth/
COPY packages/adapters/memory-queue/package.json packages/adapters/memory-queue/
COPY packages/adapters/memory-store/package.json packages/adapters/memory-store/
COPY packages/adapters/mongo-store/package.json packages/adapters/mongo-store/
COPY packages/adapters/rule-model/package.json packages/adapters/rule-model/
COPY packages/adapters/ws-gateway/package.json packages/adapters/ws-gateway/
# mongodb-memory-server would download a mongod binary at install; the image never needs it.
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY . .
# The data directory is owner-only (TASK-921) and lives on a volume.
RUN addgroup -S pca && adduser -S -G pca pca \
  && mkdir -p /data && chown pca:pca /data && chmod 700 /data
USER pca
ENV PCA_STORAGE=file
ENV PCA_DATA_FILE=/data/data.json
ENV PCA_API_HOST=0.0.0.0
ENV PCA_API_PORT=3000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
# Straight through node: nothing is resolved or downloaded at start.
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
