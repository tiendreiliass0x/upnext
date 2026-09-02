#!/bin/sh

set -eu

SERVE_DIR=${UPNEXT_SERVE_DIR:-"$HOME/dev/upnext-serve"}
SERVICE_LABEL=${UPNEXT_SERVICE_LABEL:-com.younext.upnext-serve}
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"
HEALTH_URL=${UPNEXT_HEALTH_URL:-http://127.0.0.1:3000/}

fail() {
  echo "upnext-deploy: $*" >&2
  exit 1
}

# The standalone bundle carries native modules compiled against whichever node
# builds it, and the LaunchAgent starts the server on its own Node 24, so a
# build on another major ships a bundle the service cannot load. Providing the
# right Node is the environment's job -- nvm's default alias and this project's
# .nvmrc both say 24 -- so this only refuses to build when it is wrong, rather
# than reaching into the shell to correct it.
require_project_node() {
  [ -f .nvmrc ] || fail "the deployed revision has no .nvmrc to build against"
  WANTED_MAJOR=$(sed 's/^v//; s/[^0-9].*$//; q' .nvmrc)
  [ -n "$WANTED_MAJOR" ] || fail "could not read a Node version from .nvmrc"
  [ "$(node -v | sed 's/^v//; s/\..*$//')" = "$WANTED_MAJOR" ] ||
    fail "the build needs Node $WANTED_MAJOR and this shell has $(node -v); run 'nvm use' and deploy again"
  echo "upnext-deploy: building on $(node -v)"
}

[ -d "$SERVE_DIR/.git" ] || fail "production checkout not found at $SERVE_DIR"
for command in bun curl git launchctl tar; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done
launchctl print "$SERVICE_TARGET" >/dev/null 2>&1 ||
  fail "LaunchAgent $SERVICE_LABEL is not loaded"
git -C "$SERVE_DIR" diff --quiet ||
  fail "production checkout has uncommitted tracked changes"
git -C "$SERVE_DIR" diff --cached --quiet ||
  fail "production checkout has staged changes"

BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/upnext-deploy.XXXXXX")
STAGED_NEXT="$SERVE_DIR/.next.deploy.$$"
PREVIOUS_NEXT="$SERVE_DIR/.next.previous.$$"

cleanup() {
  rm -rf "$BUILD_DIR" "$STAGED_NEXT"
}
trap cleanup 0 1 2 15

rollback() {
  echo "upnext-deploy: $1; restoring the previous build" >&2
  if [ -d "$PREVIOUS_NEXT" ]; then
    FAILED_NEXT="$SERVE_DIR/.next.failed.$$"
    if [ -d "$SERVE_DIR/.next" ]; then
      mv "$SERVE_DIR/.next" "$FAILED_NEXT"
    fi
    mv "$PREVIOUS_NEXT" "$SERVE_DIR/.next"
    launchctl kickstart -k "$SERVICE_TARGET" >/dev/null 2>&1 || true
    rm -rf "$FAILED_NEXT"
  fi
  exit 1
}

echo "upnext-deploy: updating $SERVE_DIR"
git -C "$SERVE_DIR" pull --ff-only
REVISION=$(git -C "$SERVE_DIR" rev-parse --short HEAD)

# Build away from the live standalone directory so current visitors continue
# receiving a complete build until the final restart.
git -C "$SERVE_DIR" archive HEAD | tar -xf - -C "$BUILD_DIR"
if [ -f "$SERVE_DIR/.env" ]; then
  ln -s "$SERVE_DIR/.env" "$BUILD_DIR/.env"
fi
(
  cd "$BUILD_DIR"
  require_project_node
  bun install --frozen-lockfile
  bun run build
)

mkdir "$STAGED_NEXT"
cp -R "$BUILD_DIR/.next/standalone" "$STAGED_NEXT/standalone"
mkdir -p "$STAGED_NEXT/standalone/.next"
cp -R "$BUILD_DIR/.next/static" "$STAGED_NEXT/standalone/.next/static"
if [ -d "$BUILD_DIR/public" ]; then
  cp -R "$BUILD_DIR/public" "$STAGED_NEXT/standalone/public"
fi

if [ -d "$SERVE_DIR/.next" ]; then
  mv "$SERVE_DIR/.next" "$PREVIOUS_NEXT"
fi
mv "$STAGED_NEXT" "$SERVE_DIR/.next" || rollback "could not install the build"
launchctl kickstart -k "$SERVICE_TARGET" || rollback "could not restart the service"

ATTEMPT=1
while [ "$ATTEMPT" -le 15 ]; do
  if curl -fsS --max-time 5 -o /dev/null "$HEALTH_URL"; then
    rm -rf "$PREVIOUS_NEXT"
    echo "upnext-deploy: $REVISION is live at $HEALTH_URL"
    exit 0
  fi
  sleep 1
  ATTEMPT=$((ATTEMPT + 1))
done

rollback "health check failed"
