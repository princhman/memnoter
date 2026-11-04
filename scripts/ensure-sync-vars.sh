#!/usr/bin/env bash
# Creates the local-only secrets the sync server needs in development.
# apps/sync/.dev.vars is gitignored and never used in production.
set -euo pipefail

vars="$(cd "$(dirname "$0")/.." && pwd)/apps/sync/.dev.vars"
if [[ ! -f "$vars" ]]; then
  printf 'AUTH_SECRET=%s\nDEV_RETURN_CODE=1\n' "$(openssl rand -hex 32)" > "$vars"
  echo "Created apps/sync/.dev.vars"
fi
