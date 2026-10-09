# Remote MCP server (Streamable HTTP) — `h-mcp-remote`.
#
# This image must NOT contain the backend. The process holds end-user MCP sessions, so it is kept
# away from the backend's code, its secrets and its filesystem (the spawn boundary, SC-6). It runs
# in PUBLIC MODE — no API key is baked in and none is read from requests.
#
# BUILD CONTEXT IS `mcp/`:
#     docker build -f mcp/Dockerfile -t proof-mcp-remote:latest mcp
# Everything the image needs is this package and what its lockfile names — including
# `@proof-holdings/delegation-verifier`, installed from the registry like any other dependency.
# The context cannot reach the backend, so nothing of it can enter the image; `mcp/.dockerignore`
# is the ignore file that governs it. (Until 2026-10 the context was the repository root, so the
# then-unpublished verifier could be built as a sibling; `docs/runbooks/npm-release.md` §8 step 8.)
#
# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /build

# The manifest and lockfile first, so the install layer is reused while only the source changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build \
 && npm prune --omit=dev

# Stage 2: Production (minimal image)
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Upgrade Alpine packages to patch known CVEs
RUN apk upgrade --no-cache

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

COPY --from=builder --chown=appuser:nodejs /build ./

# The server runs with `node`; the npm CLI the base image bundles is unused here and carried all
# but one of the HIGH findings Trivy reported on this image. Removed as root, before USER.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER appuser
EXPOSE 3100

CMD ["node", "dist/remote.js"]
