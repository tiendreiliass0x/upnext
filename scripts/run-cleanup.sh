#!/bin/sh
# Entry point for scheduled cleanup runs (launchd, cron).
#
# A scheduler cannot rely on the caller's PATH, and hard-coding an nvm path
# such as ~/.nvm/versions/node/v22.12.0/bin/node breaks silently the moment the
# default Node changes. Sourcing ~/.zshrc to pick up nvm would fix that by
# coupling a background job to interactive shell configuration, which is worse:
# a prompt, a `read`, or a non-zero exit in a personal rc file would then be
# able to hang or kill a scheduled job.
#
# So resolve the interpreter directly from nvm's alias file, assert it is new
# enough for the flags the cleanup script uses, and fail loudly otherwise.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NVM_ROOT="${NVM_DIR:-$HOME/.nvm}"

# macOS keeps user logs and state under ~/Library; everything else follows the
# XDG layout. The LaunchAgent's StandardOutPath must match the macOS branch.
if [ -d "$HOME/Library" ]; then
  default_log="$HOME/Library/Logs/upnext-cleanup.log"
  default_state="$HOME/Library/Application Support/com.upnext.cleanup"
else
  default_log="${XDG_STATE_HOME:-$HOME/.local/state}/upnext/cleanup.log"
  default_state="${XDG_STATE_HOME:-$HOME/.local/state}/upnext"
fi
LOG_FILE="${UPNEXT_CLEANUP_LOG:-$default_log}"
STATE_DIR="${UPNEXT_CLEANUP_STATE:-$default_state}"
# launchd appends to its log forever and has no rotation of its own, so the
# wrapper caps it. Two generations at 1 MB bounds this at ~2 MB.
MAX_LOG_BYTES=${UPNEXT_CLEANUP_MAX_LOG_BYTES:-1048576}

# Dead-man switch. Nothing self-hosted can report that this job stopped running
# entirely, because when it stops, none of this code runs. An external monitor
# inverts that: it alerts when an expected check-in does NOT arrive.
#
# Vendor-neutral on purpose. The base URL plus /start and /fail is the
# healthchecks.io convention, which self-hosted Healthchecks, Cronitor and
# Better Stack all accept. Unset means no network traffic at all.
#
# The URL is a credential: anyone holding it can forge check-ins, so it is read
# from .env, never logged, and never printed by --status.
read_dotenv() {
  [ -f "$PROJECT_DIR/.env" ] || return 0
  # Deliberately not `source`: .env is data, and sourcing it would execute it.
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$PROJECT_DIR/.env" 2>/dev/null |
    head -1 | sed -e 's/^"//' -e "s/^'//" -e 's/"$//' -e "s/'$//" -e 's/[[:space:]]*$//' |
    tr -d '\r'
}

MONITOR_URL="${CLEANUP_MONITOR_URL:-$(read_dotenv CLEANUP_MONITOR_URL)}"

redacted_monitor() {
  # Host only. The path carries the secret.
  printf '%s' "$MONITOR_URL" | sed -E 's#^([a-z]+://[^/]+).*#\1/***#'
}

ping_monitor() {
  # $1 = url suffix ("", "/start", "/fail"), $2 = optional body file
  [ -n "$MONITOR_URL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  _url="$MONITOR_URL$1"
  if [ -n "${2:-}" ] && [ -f "$2" ]; then
    curl -fsS -m 10 --retry 3 --data-binary "@$2" "$_url" >/dev/null 2>&1 || _rc=$?
  else
    curl -fsS -m 10 --retry 3 "$_url" >/dev/null 2>&1 || _rc=$?
  fi
  if [ -n "${_rc:-}" ]; then
    # A missed check-in is what the monitor is for, so this must never turn a
    # successful cleanup into a failed one. Report it and carry on.
    echo "upnext-cleanup: monitor check-in '$1' failed (curl $_rc) to $(redacted_monitor)" >&2
    unset _rc
  fi
}

log_bytes() {
  [ -f "$LOG_FILE" ] || { echo 0; return; }
  wc -c < "$LOG_FILE" | tr -d " "
}

rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  [ "$(log_bytes)" -gt "$MAX_LOG_BYTES" ] || return 0
  # launchd already holds this file open, so the current run's own output lands
  # in the rotated copy. The next run starts the fresh file.
  mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
}

# Failure has to survive the banner being missed, dismissed, or suppressed by a
# Focus mode, so it is recorded on disk as well as announced.
notify() {
  [ "${UPNEXT_CLEANUP_NOTIFY:-1}" = "1" ] || return 0
  command -v osascript >/dev/null 2>&1 || return 0
  if osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; then
    echo "upnext-cleanup: notified: $1 - $2" >&2
  else
    echo "upnext-cleanup: notification could not be posted: $1 - $2" >&2
  fi
}

# Never silent: this is the mechanism that makes failures visible, so it must
# not be able to fail quietly itself.
record() {
  if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
    echo "upnext-cleanup: cannot create state dir [$STATE_DIR] (HOME=[${HOME:-unset}])" >&2
    return 0
  fi
  if ! printf '%s\n' "$2" > "$STATE_DIR/$1" 2>/dev/null; then
    echo "upnext-cleanup: cannot write [$STATE_DIR/$1]" >&2
    return 0
  fi
}

human_age() {
  [ -f "$STATE_DIR/$1" ] || { printf 'never'; return; }
  _then=$(cat "$STATE_DIR/$1" 2>/dev/null | head -1)
  case $_then in '' | *[!0-9]*) printf 'unknown'; return ;; esac
  _age=$(( $(date +%s) - _then ))
  # -r is BSD, -d @ is GNU. Without both, this silently prints an empty date on
  # Linux, which is exactly where the scheduled job runs in production.
  _when=$(date -r "$_then" "+%Y-%m-%d %H:%M:%S" 2>/dev/null ||
          date -d "@$_then" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "unknown time")
  printf '%s (%dh %dm ago)' "$_when" "$((_age / 3600))" "$(((_age % 3600) / 60))"
}

if [ "${1:-}" = "--status" ]; then
  echo "last success : $(human_age last-success)"
  echo "last failure : $(human_age last-failure)"
  [ -f "$STATE_DIR/last-failure-reason" ] &&
    echo "               $(cat "$STATE_DIR/last-failure-reason")"
  echo "log          : $LOG_FILE ($(log_bytes) bytes, cap ${MAX_LOG_BYTES})"
  if [ -n "$MONITOR_URL" ]; then
    echo "monitor      : configured -> $(redacted_monitor)"
  else
    echo "monitor      : not configured (no dead-man switch)"
  fi
  exit 0
fi

# --env-file-if-exists landed in Node 22.9.0.
MIN_MAJOR=22
MIN_MINOR=9

# nvm aliases can chain (default -> lts/iron -> v22.12.0).
resolve_alias() {
  _name=$1
  _depth=0
  while [ -f "$NVM_ROOT/alias/$_name" ] && [ "$_depth" -lt 5 ]; do
    _name=$(cat "$NVM_ROOT/alias/$_name")
    _depth=$((_depth + 1))
  done
  printf '%s' "$_name"
}

version_ok() {
  [ -x "$1" ] || return 1
  _v=$("$1" --version 2>/dev/null) || return 1
  _v=${_v#v}
  _major=${_v%%.*}
  _rest=${_v#*.}
  _minor=${_rest%%.*}
  case $_major in '' | *[!0-9]*) return 1 ;; esac
  case $_minor in '' | *[!0-9]*) return 1 ;; esac
  [ "$_major" -gt "$MIN_MAJOR" ] && return 0
  [ "$_major" -eq "$MIN_MAJOR" ] && [ "$_minor" -ge "$MIN_MINOR" ] && return 0
  return 1
}

NODE_BIN=""
TARGET=$(resolve_alias default)
if [ -n "$TARGET" ]; then
  CANDIDATE="$NVM_ROOT/versions/node/v${TARGET#v}/bin/node"
  if version_ok "$CANDIDATE"; then NODE_BIN="$CANDIDATE"; fi
fi

# Only accept a PATH node if it also meets the minimum. An older one on PATH
# would fail on the flags below in a far more confusing way.
if [ -z "$NODE_BIN" ]; then
  CANDIDATE=$(command -v node 2>/dev/null || true)
  if [ -n "$CANDIDATE" ] && version_ok "$CANDIDATE"; then NODE_BIN="$CANDIDATE"; fi
fi

if [ -z "$NODE_BIN" ]; then
  record last-failure "$(date +%s)"
  record last-failure-reason "no Node >= $MIN_MAJOR.$MIN_MINOR found"
  notify "UP/NEXT cleanup failed" "No Node >= $MIN_MAJOR.$MIN_MINOR found. Cleanup did not run."
  ping_monitor "/fail"
  echo "upnext-cleanup: no Node >= $MIN_MAJOR.$MIN_MINOR found; cleanup did NOT run." >&2
  echo "  nvm default alias : ${TARGET:-<unset>}" >&2
  echo "  looked under      : $NVM_ROOT/versions/node" >&2
  echo "  node on PATH      : $(command -v node 2>/dev/null || echo none)" >&2
  exit 1
fi

# Lets you check which interpreter a scheduled run would use without running
# the job itself, which matters for something that otherwise only speaks to you
# through a log file.
if [ "${1:-}" = "--print-node" ]; then
  echo "$NODE_BIN ($("$NODE_BIN" --version))"
  exit 0
fi

rotate_log
cd "$PROJECT_DIR"
ping_monitor "/start"

# Deliberately not exec: the exit status has to be inspected so a failure can be
# announced rather than left in a log nobody reads. Output is captured so the
# summary can be attached to the check-in, then replayed to the log.
OUT_FILE=$(mktemp "${TMPDIR:-/tmp}/upnext-cleanup.XXXXXX")
trap 'rm -f "$OUT_FILE"' EXIT INT TERM
# Production images ship a precompiled bundle so the runtime needs neither the
# TypeScript loader nor the source tree. Local checkouts fall back to running
# the source directly.
set +e
if [ -f "$PROJECT_DIR/cleanup.mjs" ]; then
  "$NODE_BIN" --env-file-if-exists=.env cleanup.mjs > "$OUT_FILE" 2>&1
else
  "$NODE_BIN" --env-file-if-exists=.env --import tsx scripts/cleanup.ts > "$OUT_FILE" 2>&1
fi
STATUS=$?
set -e
cat "$OUT_FILE"

if [ "$STATUS" -eq 0 ]; then
  record last-success "$(date +%s)"
  # The success summary is counts and booleans only, so it is safe to send.
  ping_monitor "" "$OUT_FILE"
else
  record last-failure "$(date +%s)"
  record last-failure-reason "cleanup exited $STATUS"
  notify "UP/NEXT cleanup failed" "Exit $STATUS. See $LOG_FILE"
  # Failure output can carry stack traces with absolute paths, which would leak
  # the username and layout to a third party. Opt in explicitly to send it.
  if [ "${CLEANUP_MONITOR_SEND_OUTPUT:-0}" = "1" ]; then
    ping_monitor "/fail" "$OUT_FILE"
  else
    ping_monitor "/fail"
  fi
fi
exit "$STATUS"
