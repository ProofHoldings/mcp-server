# Remote MCP server (Streamable HTTP) — `h-mcp-remote`.
#
# This image must NOT contain the backend. The process holds end-user MCP sessions, so it is kept
# away from the backend's code, its secrets and its filesystem (the spawn boundary, SC-6). It runs
# in PUBLIC MODE — no API key is baked in and none is read from requests.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not `mcp/`:
#     docker build -f mcp/Dockerfile -t proof-mcp-remote:latest .
# The reason is `@proof-holdings/delegation-verifier`, a runtime dependency of `mcp/package.json`.
# While the registry cannot resolve the range it declares, a build from `mcp/` alone dies at
# `npm ci` with a 404 — verified, not assumed — so the verifier is built from the sibling directory
# and the specifier is repointed at it, the same arrangement `mcp-tests` and `verifier-tests` use in
# CI. That is a workaround with an end date: once the verifier is on npm this stage collapses back
# to a plain `npm ci` inside `mcp/`. Retiring it is a step of the release sequence in
# `docs/runbooks/npm-release.md`, alongside the CI jobs that repoint for the same reason — not
# something publication does by itself, and nothing here goes red when it becomes unnecessary.
#
# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /build

COPY packages/delegation-verifier ./packages/delegation-verifier
RUN npm ci --prefix packages/delegation-verifier \
 && npm run --prefix packages/delegation-verifier build

COPY mcp ./mcp
RUN npm pkg set 'dependencies.@proof-holdings/delegation-verifier=file:../packages/delegation-verifier' --prefix mcp \
 && npm install --prefix mcp --no-audit --no-fund \
 && npm run --prefix mcp build \
 && npm prune --omit=dev --prefix mcp

# Stage 2: Production (minimal image)
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Upgrade Alpine packages to patch known CVEs
RUN apk upgrade --no-cache

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# Both directories, and in this layout: the installed dependency is a link to the sibling path, so
# moving either one alone leaves a dangling module.
COPY --from=builder --chown=appuser:nodejs /build/packages/delegation-verifier ./packages/delegation-verifier
COPY --from=builder --chown=appuser:nodejs /build/mcp ./mcp

WORKDIR /app/mcp
USER appuser
EXPOSE 3100

CMD ["node", "dist/remote.js"]
