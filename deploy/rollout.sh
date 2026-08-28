#!/usr/bin/env bash
# Runs ON THE VPS, fed over SSH by .github/workflows/deploy.yml. Expects
# APP_DIR, IMAGE, TAG, GHCR_USER, GHCR_TOKEN in the environment.
#
# Pull the image CI built, switch the compose stack to it, wait for the
# container's own healthcheck, and if it never goes healthy put the previous
# tag back. The checkout is updated too, because Caddyfile and
# docker-compose.yml are read from it, not from the image.
set -euo pipefail

cd "$APP_DIR"
previous=$(grep -E '^UPNEXT_IMAGE_TAG=' .env 2>/dev/null | cut -d= -f2- || true)
echo "Deploying $IMAGE:$TAG (previous: ${previous:-none})"

git fetch -q origin main
git checkout -q main
git reset -q --hard origin/main

echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null

set_tag() {
  if grep -qE '^UPNEXT_IMAGE_TAG=' .env 2>/dev/null; then
    sed -i "s|^UPNEXT_IMAGE_TAG=.*|UPNEXT_IMAGE_TAG=$1|" .env
  else
    printf 'UPNEXT_IMAGE_TAG=%s\n' "$1" >> .env
  fi
}

wait_healthy() {
  # start_period is 20s and the check runs every 30s; give it three checks.
  for _ in $(seq 1 24); do
    status=$(docker inspect --format '{{.State.Health.Status}}' \
      "$(docker compose ps -q app)" 2>/dev/null || echo "missing")
    case "$status" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 5
  done
  return 1
}

set_tag "$TAG"
docker compose pull -q app
docker compose up -d --no-build --remove-orphans

if wait_healthy; then
  echo "Healthy on $TAG"
  docker logout ghcr.io >/dev/null 2>&1 || true
  docker image prune -f >/dev/null
  exit 0
fi

echo "::error::$TAG never became healthy"
docker compose logs --tail=80 app || true
if [ -n "$previous" ]; then
  echo "Rolling back to $previous"
  set_tag "$previous"
  docker compose up -d --no-build
  wait_healthy && echo "Rolled back to $previous" || echo "::error::Rollback did not become healthy either"
fi
exit 1
