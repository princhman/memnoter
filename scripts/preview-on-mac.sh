#!/bin/bash
# Let the user try a branch in the desktop app on the Mac while an agent works
# on it from another machine (usually minipc).
#
#   On the working machine:  scripts/preview-on-mac.sh push
#     Force-pushes HEAD to origin as preview/<branch>. CI and Cloudflare ignore
#     preview/* branches.
#
#   On the Mac, once:        scripts/preview-on-mac.sh serve <branch>
#     Checks preview/<branch> out into ~/Projects/notes-preview, starts
#     `pnpm dev` there with its own data directory, and follows the branch: each
#     later push is pulled in within ~15s and hot-reloaded (Rust changes
#     rebuild automatically). So after the first launch no Mac-side agent is
#     needed; the user presses Cmd+R if the window doesn't refresh by itself.
#
#   On the Mac:              scripts/preview-on-mac.sh status | stop
#
# The preview worktree is owned by this script: serve resets it to the pushed
# commit, discarding anything edited there.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
preview_dir=${MEMNOTER_PREVIEW_DIR:-$HOME/Projects/notes-preview}
data_dir="$HOME/Library/Application Support/memnoter-preview"
state=${TMPDIR:-/tmp}/memnoter-preview
mkdir -p "$state"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

alive() { [ -f "$state/$1.pid" ] && kill -0 "$(cat "$state/$1.pid")" 2>/dev/null; }

stop() {
  for name in follow dev; do
    if alive "$name"; then
      # Kill the whole process group so pnpm, vite and the app all exit.
      kill -- "-$(cat "$state/$name.pid")" 2>/dev/null || kill "$(cat "$state/$name.pid")" 2>/dev/null || true
    fi
    rm -f "$state/$name.pid"
  done
}

# Starts a command detached from this shell: its own process group, no stdin,
# output to a log. Agents' tool calls return immediately instead of hanging.
detach() {
  local name=$1; shift
  perl -e 'setpgrp(0,0); exec @ARGV' "$@" < /dev/null > "$state/$name.log" 2>&1 &
  echo $! > "$state/$name.pid"
  disown
}

sync_to() {
  local ref=$1
  local before
  before=$(git -C "$preview_dir" rev-parse HEAD 2>/dev/null || echo none)
  git -C "$preview_dir" reset --quiet --hard "$ref"
  if [ "$before" = none ] || [ ! -d "$preview_dir/node_modules" ] ||
    ! git -C "$preview_dir" diff --quiet "$before" HEAD -- pnpm-lock.yaml; then
    (cd "$preview_dir" && pnpm install --frozen-lockfile --silent)
  fi
}

cmd=${1:-}
case "$cmd" in
  push)
    branch=$(git -C "$repo" branch --show-current)
    [ -n "$branch" ] || { echo "Not on a branch." >&2; exit 1; }
    [ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] ||
      echo "Note: uncommitted changes are not included. Commit first if the user should see them." >&2
    git -C "$repo" push --quiet --force origin "HEAD:refs/heads/preview/$branch"
    echo "Pushed $(git -C "$repo" rev-parse --short HEAD) to preview/$branch."
    echo "If the Mac isn't already following it, run there: scripts/preview-on-mac.sh serve $branch"
    ;;

  serve)
    branch=${2:-}
    [ -n "$branch" ] || usage
    [ "$(uname)" = Darwin ] || { echo "serve runs on the Mac." >&2; exit 1; }
    stop
    if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Port 1420 is in use by another dev server; stop it first:" >&2
      lsof -nP -iTCP:1420 -sTCP:LISTEN >&2
      exit 1
    fi
    git -C "$repo" fetch --quiet origin "preview/$branch"
    if [ ! -d "$preview_dir" ]; then
      git -C "$repo" worktree add --quiet --detach "$preview_dir" FETCH_HEAD
    fi
    git -C "$preview_dir" fetch --quiet origin "preview/$branch"
    sync_to FETCH_HEAD
    mkdir -p "$data_dir"
    echo "$branch" > "$state/branch"
    (cd "$preview_dir" && export MEMNOTER_DATA_DIR="$data_dir" && detach dev pnpm dev)
    # Run the follower from a copy: bash reads scripts lazily, so switching
    # branches in the main checkout must not rewrite it mid-run.
    cp "$0" "$state/follow.sh"
    detach follow bash "$state/follow.sh" follow "$branch"
    echo "Previewing preview/$branch at $(git -C "$preview_dir" rev-parse --short HEAD) from $preview_dir."
    echo "The first Rust build takes a few minutes. Log: $state/dev.log"
    ;;

  follow)
    branch=${2:-}
    [ -n "$branch" ] || usage
    while sleep 15; do
      git -C "$preview_dir" fetch --quiet origin "preview/$branch" 2>/dev/null || continue
      if [ "$(git -C "$preview_dir" rev-parse HEAD)" != "$(git -C "$preview_dir" rev-parse FETCH_HEAD)" ]; then
        sync_to FETCH_HEAD && echo "$(date '+%H:%M:%S') now at $(git -C "$preview_dir" rev-parse --short HEAD)"
      fi
    done
    ;;

  status)
    if alive dev; then
      echo "Previewing preview/$(cat "$state/branch") at $(git -C "$preview_dir" rev-parse --short HEAD)"
      alive follow && echo "Following pushes." || echo "Not following pushes (run serve again)."
      tail -n 5 "$state/dev.log"
    else
      echo "No preview running."
    fi
    ;;

  stop)
    stop
    echo "Preview stopped."
    ;;

  *) usage ;;
esac
