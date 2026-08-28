# syntax=docker/dockerfile:1

# Build on Linux, never ship the host's binaries. better-sqlite3 resolves to a
# platform-specific binding at install time, and a macOS build is a Mach-O
# binary that cannot run in this image.
#
# Every stage is a Node image with the bun binary copied in, rather than the
# bun image itself. bun is the package manager (bun.lock is the lockfile) but
# it reports itself as node v26, so inside oven/bun the better-sqlite3 install
# script looks for a prebuild that does not exist and falls back to compiling
# against the wrong ABI. With real Node present, prebuild-install resolves the
# Node 22 prebuild that matches the runtime below.
#
# Node is also the only possible runtime here: bun cannot load better-sqlite3's
# native binding at all.

FROM oven/bun:1 AS bunbin

FROM node:22-slim AS deps
COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM node:22-slim AS build
COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build
# Precompile the cleanup job so the runtime needs neither tsx nor src/. The
# two native/SDK packages stay external because the traced server already
# carries them.
# Only the native module stays external. The AWS SDK is bundled in, because
# Next inlines it into the traced server rather than leaving it resolvable as a
# package in standalone node_modules.
RUN bun build scripts/cleanup.ts --target=node --outfile=cleanup.mjs \
      --external better-sqlite3

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    SQLITE_PATH=/data/dj-booth.sqlite

# curl is what the cleanup wrapper uses to check in with the dead-man switch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Standalone carries only the traced server and its real dependencies.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY public ./public

# The cleanup job as a single precompiled file, plus the wrapper that schedules
# it. Its two external packages already sit in the traced server's node_modules.
COPY --from=build /app/cleanup.mjs ./cleanup.mjs
COPY scripts/run-cleanup.sh ./scripts/run-cleanup.sh

# The volume is mounted at /data and must be writable by the app user.
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
