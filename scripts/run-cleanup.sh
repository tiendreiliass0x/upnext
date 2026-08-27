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

cd "$PROJECT_DIR"
exec "$NODE_BIN" --env-file-if-exists=.env --import tsx scripts/cleanup.ts
