#!/bin/bash
# List git worktrees that are safe to delete, and delete them with --apply.
#
#   scripts/prune-worktrees.sh            dry run: show what would go and why the rest stay
#   scripts/prune-worktrees.sh --apply    remove the safe ones
#
# A worktree is "safe" only when ALL of these hold:
#   - it has no uncommitted or untracked changes,
#   - its HEAD is already contained in origin/main or in its branch's upstream
#     (so no commit exists only there),
#   - no process has its current directory inside it (no dev server running).
# The main checkout is never touched. Branches are kept; only the worktree
# directories (and their per-worktree target/ and node_modules/) go.
set -euo pipefail
cd "$(dirname "$0")/.."

apply=false
[ "${1:-}" = "--apply" ] && apply=true

git fetch --quiet origin 2>/dev/null || echo "warning: git fetch failed; using the last known origin/main" >&2
main_wt=$(git rev-parse --show-toplevel)
busy=$(lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u)

safe=() kept=0
while IFS= read -r line; do
  case "$line" in worktree\ *) wt=${line#worktree } ;; *) continue ;; esac
  [ "$wt" = "$main_wt" ] && continue
  if [ ! -d "$wt" ]; then safe+=("$wt"); echo "gone     $wt (directory missing)"; continue; fi
  reason=""
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    reason="uncommitted changes"
  else
    head=$(git -C "$wt" rev-parse HEAD)
    upstream=$(git -C "$wt" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
    if ! git merge-base --is-ancestor "$head" origin/main 2>/dev/null &&
       { [ -z "$upstream" ] || ! git merge-base --is-ancestor "$head" "$upstream" 2>/dev/null; }; then
      reason="commits not on origin/main or its upstream"
    elif grep -qF "$wt" <<<"$busy"; then
      reason="a process is running inside it"
    fi
  fi
  if [ -n "$reason" ]; then
    kept=$((kept + 1)); echo "keep     $wt ($reason)"
  else
    safe+=("$wt"); echo "removable $wt ($(du -sh "$wt" 2>/dev/null | cut -f1))"
  fi
done < <(git worktree list --porcelain)

echo
echo "${#safe[@]} removable, $kept kept."
if [ "$apply" = false ]; then
  [ ${#safe[@]} -gt 0 ] && echo "Run with --apply to remove them."
  exit 0
fi
for wt in "${safe[@]}"; do
  if [ -d "$wt" ]; then git worktree remove --force "$wt"; fi
done
git worktree prune
echo "Removed ${#safe[@]} worktrees."
