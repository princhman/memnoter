#!/usr/bin/env bash
# Try sync locally with two copies of the app, each with its own throwaway
# data dir under .sync-dev/, against the sync server running on this machine.
# Your real notes and the installed app are never touched.
#
#   scripts/sync-dev.sh          start the server and both copies
#   scripts/sync-dev.sh --reset  delete the throwaway data first
#
# In each copy open Settings > Sync, use any email address; the sign-in code
# is shown on screen in development.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
data="$root/.sync-dev"

if [[ "${1:-}" == "--reset" ]]; then
  rm -rf "$data"
fi
mkdir -p "$data/a" "$data/b"
"$root/scripts/ensure-sync-vars.sh"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd "$root/apps/sync" && pnpm install --frozen-lockfile >/dev/null && pnpm exec wrangler dev --port 8787 --persist-to "$data/server") &
pids+=($!)

# Copy A runs Vite and builds the debug binary.
(cd "$root" && MEMNOTER_DATA_DIR="$data/a" pnpm tauri dev) &
pids+=($!)

# Copy B reuses that binary and Vite server once they are up.
until curl -fs http://localhost:1420 >/dev/null 2>&1 && [[ -x "$root/target/debug/memnoter" ]]; do sleep 2; done
sleep 5
MEMNOTER_DATA_DIR="$data/b" "$root/target/debug/memnoter" &
pids+=($!)

wait
