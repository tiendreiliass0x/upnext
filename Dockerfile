# syntax=docker/dockerfile:1

# Build on Linux, never ship the host's binaries. better-sqlite3 resolves to a
# platform-specific binding at install time, and a macOS build is a Mach-O
# binary that cannot run in this image.
#
# Every stage is a Node image with the bun binary copied in, rather than the
# bun image itself. bun is the package manager (bun.lock is the lockfile);
# Node is the runtime, because the standalone server Next emits is a Node
# program and the cleanup job runs under Node too. Installing, building and
# running on one Node major keeps every stage on the runtime that ships.
# (better-sqlite3 13 is N-API and carries its prebuilt bindings inside the
# package, so the install no longer depends on which runtime runs it; the
# single-Node-image layout stays for the reason above, not for the binding.)

FROM oven/bun:1.4.0 AS bunbin

FROM node:24-slim AS deps
COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
# --ignore-scripts: better-sqlite3 13 ships its prebuilt bindings in the
# package and has no install script, but bun sees its binding.gyp and runs
# node-gyp anyway (ignoring the package's gypfile: false), which needs Python
# and fails on this slim image. Nothing in the image needs a lifecycle script:
# the platform binaries all arrive as optional dependencies.
RUN bun install --frozen-lockfile --ignore-scripts

FROM node:24-slim AS build
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

FROM node:24-slim AS runtime
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
