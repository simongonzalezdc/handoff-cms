# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# @cms/server production image.
#
# - Apache-2.0 workspace (private packages, no proprietary dependencies).
# - Multi-stage build: deps cache -> workspace build -> minimal runtime.
# - Multi-stage runtime contains only the deployed production dependency graph.
# - Runs the @cms/server ESM executable as a non-root user with an explicit
#   liveness healthcheck.
# - No secrets or CMS_* values are baked into the image. The container is
#   configured exclusively at runtime via environment variables; the
#   compose file interpolates them from a managed .env that only the
#   agency / developer operator has access to.
# -----------------------------------------------------------------------------

ARG NODE_VERSION=22.20.0
ARG PNPM_VERSION=9.15.0

# ---------- stage 1: monorepo dependency cache ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ARG PNPM_VERSION
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH

RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      ca-certificates \
      curl \
      python3 \
      build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && pnpm --version

WORKDIR /workspace

# Copy workspace manifests first so this layer caches deterministically.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/api/package.json ./packages/api/
COPY packages/storage/package.json ./packages/storage/
COPY packages/server/package.json ./packages/server/

# All remaining workspace packages so transitive workspace links resolve.
COPY packages/adapter-sdk/package.json ./packages/adapter-sdk/
COPY packages/adapter-cerafica/package.json ./packages/adapter-cerafica/
COPY packages/audit/package.json ./packages/audit/
COPY packages/cli/package.json ./packages/cli/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/licensing-guard/package.json ./packages/licensing-guard/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/media/package.json ./packages/media/
COPY packages/web/package.json ./packages/web/

# Frozen lockfile install keeps the image byte-deterministic and prevents
# the cache from silently drifting on resolve.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod=false --ignore-scripts=false

# ---------- stage 2: workspace build ----------
FROM deps AS build

WORKDIR /workspace

# Bring in source for every workspace package and the migrations directory
# so the @cms/storage package can ship them with the published artifact.
COPY tsconfig.json ./
COPY packages/core ./packages/core
COPY packages/api ./packages/api
COPY packages/storage ./packages/storage
COPY packages/server ./packages/server
COPY packages/adapter-sdk ./packages/adapter-sdk
COPY packages/adapter-cerafica ./packages/adapter-cerafica
COPY packages/audit ./packages/audit
COPY packages/cli ./packages/cli
COPY packages/i18n ./packages/i18n
COPY packages/licensing-guard ./packages/licensing-guard
COPY packages/mcp ./packages/mcp
COPY packages/media ./packages/media
COPY packages/web ./packages/web
COPY scripts ./scripts

# Build the whole workspace; the server's start script binds to its built
# dist/index.js so every dependency must compile.
RUN pnpm --filter './packages/*' -r run build

# Prune dev-only modules to shrink the runtime image. --prod keeps only
# production dependencies in node_modules while preserving workspace links.
RUN pnpm install --frozen-lockfile --prod \
 && pnpm deploy --filter @cms/server --prod /workspace/server-deploy

# ---------- stage 3: minimal runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG CMS_UID=10001
ARG CMS_GID=10001

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    # The server is fail-closed; defaults below are non-secret overrides
    # that compose can override via CMS_* vars on every deploy.
    CMS_NODE_ENV=production \
    CMS_HOSTNAME=0.0.0.0 \
    CMS_PORT=8080 \
    CMS_DEFAULT_LOCALE=en \
    CMS_LOG_LEVEL=info \
    CMS_OBJECT_FORCE_PATH_STYLE=true \
    CMS_OBJECT_REGION=us-east-1 \
    CMS_OIDC_ALGORITHMS=RS256,ES256 \
    CMS_OIDC_JWKS_CACHE_SECONDS=300 \
    CMS_OIDC_FETCH_TIMEOUT_MS=5000 \
    CMS_QUOTA_REQUEST_BYTES_CAP=1048576 \
    CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE=120

RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid ${CMS_GID} cms \
 && useradd  --system --uid ${CMS_UID} --gid cms \
              --home-dir /home/cms \
              --shell /usr/sbin/nologin \
              --create-home cms

WORKDIR /home/cms/app

# `pnpm deploy` materializes the built server and its complete production
# dependency graph, including workspace packages and their migrations.
COPY --from=build --chown=cms:cms /workspace/server-deploy ./

# Healthcheck script — small, deterministic, no external deps.
COPY --from=build --chown=cms:cms /workspace/scripts/self-host-healthcheck.mjs  /usr/local/bin/self-host-healthcheck.mjs

# Sanity check: ensure the executable is present and readable, then drop
# capabilities from the root tree.
RUN chmod 0555 /usr/local/bin/self-host-healthcheck.mjs \
 && test -f /home/cms/app/dist/index.js \
 && chmod -R u=rwX,go=rX /home/cms/app

USER cms:cms

EXPOSE 8080

# tini reaps zombies; the server is a long-lived Node ESM process.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "./dist/index.js"]

# ---- probes ----------------------------------------------------------------
# Liveness — process-only, fast, no dependency I/O.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/bin/self-host-healthcheck.mjs", "live"]

# Labels make the image discoverable in registries without leaking secrets.
LABEL org.opencontainers.image.title="cms-server" \
      org.opencontainers.image.description="Apache-2.0 self-hosted Handoff CMS server (Node 22 ESM)." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Handoff CMS"
