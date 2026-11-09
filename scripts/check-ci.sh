#!/bin/bash
# Runs what .github/workflows/ci.yml runs, so a PR is green before it is pushed.
#
#   pnpm check:ci           all jobs; the iOS job builds on macOS only
#   pnpm check:ci --quick   skip the iOS build
#
# The iOS job's simulator tests are not run here; they need a simulator and the
# local sync worker. Build failures, which are most iOS CI failures, are caught.
#
# Keep this in step with ci.yml when jobs change.
set -euo pipefail
cd "$(dirname "$0")/.."

quick=false
for arg in "$@"; do
  case "$arg" in
    --quick) quick=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
failed=()
run() {
  local name=$1; shift
  step "$name"
  if ! "$@"; then failed+=("$name"); fi
}

# Job: check (macos-latest)
run "build" pnpm build
run "lint" pnpm lint
run "shared-ui tests" pnpm test
run "cargo test" cargo test --workspace
run "cargo clippy" cargo clippy --workspace --all-targets -- -D warnings

# Job: sync-server (ubuntu-latest)
run "sync typecheck" pnpm --filter memnoter-sync typecheck
run "sync tests" pnpm --filter memnoter-sync test

# Job: ios (macos-latest)
if [ "$quick" = true ]; then
  step "iOS: skipped (--quick)"
elif [ "$(uname)" != Darwin ]; then
  step "iOS: skipped (needs macOS; CI will still run it)"
else
  # Chained with && because `set -e` is off inside `if !` in run().
  ios_build() {
    ./scripts/build-ios-core.sh &&
    ./scripts/build-ios-web.sh &&
    (cd apps/ios && xcodegen generate) &&
    xcodebuild build-for-testing -project apps/ios/Memnoter.xcodeproj -scheme Memnoter \
      -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath apps/ios/build-check ARCHS=arm64 CODE_SIGNING_ALLOWED=NO -quiet
  }
  run "iOS build" ios_build
fi

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "check:ci passed"
else
  printf 'check:ci FAILED: %s\n' "${failed[*]}"
  exit 1
fi
