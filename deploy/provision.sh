#!/usr/bin/env bash
# Provision a fresh Debian/Ubuntu VPS to serve UP/NEXT, and start it.
#
# Idempotent: safe to re-run after a failure or to redeploy a new commit.
# Everything the app needs at runtime — Node, SQLite, FFmpeg — lives inside the
# image, so the host only gets Docker. That keeps the versions that were
# actually tested, rather than whatever the distro ships.
#
#   sudo bash deploy/provision.sh                 # derive hostname from the public IP
#   sudo bash deploy/provision.sh --host dj.example.com
#   sudo bash deploy/provision.sh --dry-run       # print the plan, change nothing
set -euo pipefail

APP_DIR=${APP_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
HOSTNAME_ARG=""
DRY_RUN=0
SKIP_FIREWALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOSTNAME_ARG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
run()  {
  if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

# ---------------------------------------------------------------- preflight
say "Checking the host"
[ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "Run with sudo."
[ -f /etc/os-release ] || die "Unrecognised system: no /etc/os-release."
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) : ;;
  *) die "This script targets Debian or Ubuntu; found '${PRETTY_NAME:-unknown}'." ;;
esac
ARCH=$(dpkg --print-architecture)
case "$ARCH" in amd64|arm64) : ;; *) die "Unsupported architecture: $ARCH" ;; esac
info "${PRETTY_NAME:-unknown} on $ARCH"

[ -f "$APP_DIR/docker-compose.yml" ] || die "No docker-compose.yml in $APP_DIR. Run this from a checkout of the repo."

TOTAL_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
info "RAM: ${TOTAL_MB} MB"

# ------------------------------------------------------------------- swap
# `next build` is the memory-hungry step and will OOM on a small box long
# before serving ever does. Swap is slow but it is the difference between a
# build that finishes and one that is killed.
if [ "$TOTAL_MB" -lt 4000 ] && [ ! -f /swapfile ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  say "Adding 2G swap (RAM is under 4 GB and next build needs headroom)"
  # Swap is an optimisation, not a requirement, and fallocate is unsupported on
  # some filesystems. Never let this abort a provision that is otherwise fine.
  add_swap() {
    run bash -c 'fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none'
    run chmod 600 /swapfile
    run mkswap /swapfile >/dev/null
    run swapon /swapfile
    if ! grep -q '^/swapfile' /etc/fstab 2>/dev/null; then
      run bash -c 'echo "/swapfile none swap sw 0 0" >> /etc/fstab'
    fi
    # A shell function returns its last command's status, which would report
    # success for a swapfile that was never created. Confirm it is really on.
    [ "$DRY_RUN" = 1 ] || swapon --show=NAME --noheadings 2>/dev/null | grep -q '^/swapfile$'
  }
  if add_swap; then
    info "Swap active."
  else
    info "WARNING: could not create swap. Provisioning continues, but if the"
    info "build is killed for memory, that is why."
    run rm -f /swapfile
  fi
else
  info "Swap: already present or plenty of RAM; skipping."
fi

# ------------------------------------------------------------- base packages
say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
run apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git cron unattended-upgrades

# Security updates without a human in the loop. A box serving strangers should
# not sit on a known-unpatched OpenSSL for weeks.
run dpkg-reconfigure -f noninteractive unattended-upgrades

# -------------------------------------------------------------------- docker
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  info "Docker already installed; skipping."
else
  say "Installing Docker Engine and the compose plugin"
  run install -m 0755 -d /etc/apt/keyrings
  run bash -c "curl -fsSL https://download.docker.com/linux/${ID}/gpg -o /etc/apt/keyrings/docker.asc"
  run chmod a+r /etc/apt/keyrings/docker.asc
  run bash -c "echo \"deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable\" > /etc/apt/sources.list.d/docker.list"
  run apt-get update -qq
  run apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run systemctl enable --now docker
fi

# ------------------------------------------------------------------ hostname
say "Working out the public hostname"
if [ -n "$HOSTNAME_ARG" ]; then
  SITE_HOST="$HOSTNAME_ARG"
  info "Using --host: $SITE_HOST"
else
  # Read the address off the default route rather than asking an outside
  # service, so provisioning needs no third party.
  PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  [ -n "$PUBLIC_IP" ] || die "Could not determine this machine's IP. Pass --host explicitly."
  case "$PUBLIC_IP" in
    10.*|192.168.*|127.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
      die "Default route address $PUBLIC_IP is private, so it cannot serve guests. Pass --host with your public hostname." ;;
  esac
  SITE_HOST="${PUBLIC_IP//./-}.sslip.io"
  info "Derived from $PUBLIC_IP: $SITE_HOST"
  info "sslip.io is a shared domain and Let's Encrypt rate-limits per domain."
  info "If certificate issuance fails, a domain of your own fixes it permanently."
fi

# ----------------------------------------------------------------- .env file
say "Checking configuration"
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  run cp "$APP_DIR/.env.example" "$ENV_FILE"
  info "Created .env from .env.example."
fi

set_env() {
  local key=$1 value=$2
  if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] set %s\n' "$key"; return; fi
  if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    sed -i "s|^[[:space:]]*${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}
set_env SITE_ADDRESS "$SITE_HOST"
set_env APP_PUBLIC_URL "https://$SITE_HOST"
info "SITE_ADDRESS and APP_PUBLIC_URL set to $SITE_HOST"

# R2 credentials cannot be guessed, and starting without them would let a DJ
# build a room whose uploads fail at the last step.
if [ "$DRY_RUN" = 0 ]; then
  missing=""
  for key in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    grep -qE "^[[:space:]]*${key}=.+" "$ENV_FILE" || missing="$missing $key"
  done
  if [ -n "$missing" ]; then
    die "Missing in $ENV_FILE:$missing
Add your Cloudflare R2 credentials, then run this script again."
  fi
  info "R2 credentials present."
fi

# ------------------------------------------------------------------ firewall
if [ "$SKIP_FIREWALL" = 1 ]; then
  info "Firewall: skipped by request."
else
  say "Configuring the firewall"
  run apt-get install -y -qq ufw
  # SSH first and always: a firewall enabled without it locks you out.
  run ufw allow 22/tcp
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  run ufw --force enable
fi

# -------------------------------------------------------------------- deploy
say "Building and starting the stack"
run bash -c "cd '$APP_DIR' && docker compose up -d --build"

# --------------------------------------------------------------------- cron
say "Scheduling the cleanup job"
CRON_FILE=/etc/cron.d/upnext-cleanup
CRON_LINE="0 * * * * root cd $APP_DIR && /usr/bin/docker compose exec -T app ./scripts/run-cleanup.sh >> /var/log/upnext-cleanup.log 2>&1"
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] would write $CRON_FILE"
else
  printf '# Reclaims expired rooms and the R2 previews they hold open.\n%s\n' "$CRON_LINE" > "$CRON_FILE"
  chmod 0644 "$CRON_FILE"
  info "Hourly cleanup installed at $CRON_FILE"
fi

# -------------------------------------------------------------------- verify
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run complete. Nothing was changed."
  exit 0
fi

say "Waiting for the app to answer"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:80" 2>/dev/null ||
     docker compose -f "$APP_DIR/docker-compose.yml" exec -T app \
       node -e 'fetch("http://127.0.0.1:3000/api/sessions/HEALTH").then(r=>process.exit(r.status===404?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    ready=1; break
  fi
  sleep 3
done

if [ "$ready" = 1 ]; then
  say "UP/NEXT is live at https://$SITE_HOST"
  info "Caddy requests its certificate on the first outside request, so the"
  info "very first load may take a few seconds."
else
  say "The stack started but did not answer in time"
  info "Check: docker compose -f $APP_DIR/docker-compose.yml logs --tail=50"
  exit 1
fi

cat <<EOF

    Useful commands, all from $APP_DIR:
      docker compose logs -f app          follow application logs
      docker compose exec -T app ./scripts/run-cleanup.sh --status
      docker compose up -d --build        redeploy after a git pull

    Not configured yet, and worth doing:
      CLEANUP_MONITOR_URL in .env  - alerts you when the hourly cleanup stops
      A domain of your own         - avoids sslip.io's shared rate limits

EOF
