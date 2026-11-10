#!/bin/bash
# List git worktrees that are safe to delete, and delete them with --apply.
#
#   scripts/prune-worktrees.sh            dry run: show what would go and why the rest stay
#   scripts/prune-worktrees.sh --apply    remove the safe ones
#   scripts/prune-worktrees.sh --all      back up, then remove every worktree except
#                                         the main checkout, busy ones and ones
#                                         touched in the last hour
#
# A worktree is "safe" only when ALL of these hold:
#   - it has no uncommitted or untracked changes,
#   - its HEAD is already contained in origin/main or in its branch's upstream
#     (so no commit exists only there),
#   - no process has its current directory inside it (no dev server running).
# The main checkout is never touched. Branches are kept; only the worktree
# directories (and their per-worktree target/ and node_modules/) go.
#
# --all backup: uncommitted changes (tracked and untracked, not ignored) and
# commits not on any branch are saved as refs/backup/worktrees/<name>, which
# survive the removal. Restore with
#   git worktree add <dir> refs/backup/worktrees/<name>
# List them with `git for-each-ref refs/backup/worktrees`.
set -euo pipefail
cd "$(dirname "$0")/.."

apply=false all=false
case "${1:-}" in
  --apply) apply=true ;;
  --all) apply=true all=true ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

# Save a worktree's full non-ignored state (HEAD plus uncommitted changes) as a ref.
backup() {
  local wt=$1 name index tree commit
  name=$(basename "$wt")
  index=$(mktemp)
  GIT_INDEX_FILE=$index git -C "$wt" add -A
  tree=$(GIT_INDEX_FILE=$index git -C "$wt" write-tree)
  rm -f "$index"
  commit=$(git -C "$wt" commit-tree "$tree" -p HEAD -m "Backup of worktree $wt before removal")
  git update-ref "refs/backup/worktrees/$name" "$commit"
  echo "  backed up to refs/backup/worktrees/$name"
}
recent=$(( $(date +%s) - 3600 ))

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
  if [ -n "$reason" ] && [ "$all" = true ] && ! grep -qF "$wt" <<<"$busy" &&
     [ "$(stat -f %m "$(git -C "$wt" rev-parse --git-dir)" 2>/dev/null || echo 0)" -lt "$recent" ]; then
    echo "removable $wt ($reason, will back up)"
    [ "$apply" = true ] && backup "$wt"
    safe+=("$wt")
  elif [ -n "$reason" ]; then
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
