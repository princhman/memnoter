#!/bin/bash
# Run the desktop dev build against a fresh copy of the user's real notes, so a
# branch can never migrate or rewrite the database that /Applications/Memnoter.app
# uses. (On 2026-11-09 a build from main moved main.db to schema 7 and the
# installed 0.1.3 app then refused to start.)
#
#   pnpm dev:copy                 copy real data, then `tauri dev` on the copy
#   pnpm dev:copy --keep          reuse the previous copy instead of refreshing it
#   pnpm dev:copy --no-launch     only make the copy and print its path
#
# The copy has no sync login (credentials are keyed by data dir), so it never
# uploads anything. Edits made in it are thrown away on the next refresh.
# MEMNOTER_DATA_DIR only works in debug builds; release builds always use the
# real data dir.
set -euo pipefail
cd "$(dirname "$0")/.."

real="$HOME/Library/Application Support/com.vladyslavnalyvaiko.memnoter"
copy="${MEMNOTER_COPY_DIR:-$HOME/Library/Application Support/memnoter-dev-copy}"
keep=false
launch=true
for arg in "$@"; do
  case "$arg" in
    --keep) keep=true ;;
    --no-launch) launch=false ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$keep" = false ] || [ ! -f "$copy/main.db" ]; then
  if [ ! -f "$real/main.db" ]; then
    echo "No real data at $real; starting with an empty copy." >&2
    rm -rf "$copy" && mkdir -p "$copy"
  else
    rm -rf "$copy" && mkdir -p "$copy"
    # sqlite3 .backup takes a consistent snapshot even while the real app is
    # open and writing (main.db-wal included).
    sqlite3 "$real/main.db" ".backup '$copy/main.db'"
    for dir in files documents; do
      # -c clones on APFS, so this is instant and takes no extra space.
      [ -d "$real/$dir" ] && cp -Rc "$real/$dir" "$copy/$dir" 2>/dev/null || cp -R "$real/$dir" "$copy/$dir" 2>/dev/null || true
    done
  fi
fi

version=$(sqlite3 "$copy/main.db" "PRAGMA user_version" 2>/dev/null || echo "?")
echo "Dev data: $copy (schema $version)"
[ "$launch" = true ] || exit 0
MEMNOTER_DATA_DIR="$copy" exec pnpm tauri dev
