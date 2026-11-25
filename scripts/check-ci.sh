#!/bin/bash
# Runs what .github/workflows/ci.yml runs, so a PR is green before it is pushed.
#
#   pnpm check:ci           all jobs, plus the iOS build on macOS
#   pnpm check:ci --quick   skip the iOS build
#
# CI has no iOS job. With iOS changes, run this on the Mac and the iOS
# simulator tests (apps/ios/README.md, Tests) before pushing.
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
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
failed=()
run() {
  local name=$1; shift
  step "$name"
  if ! "$@"; then failed+=("$name"); fi
}

# Jobs: frontend, web, rust
run "CI selection and gates" python3 -m unittest discover -s scripts/tests -p test_ci_selection.py
run "iOS live configuration" node --test scripts/tests/ios-live-plist.test.mjs
run "build" pnpm build
run "lint" pnpm lint
run "shared-ui tests" pnpm --filter memnoter-shared-ui test:ci
run "cargo test" cargo test --workspace
run "cargo clippy" cargo clippy --workspace --all-targets -- -D warnings

# Job: sync-server (ubuntu-latest)
run "sync typecheck" pnpm --filter memnoter-sync typecheck
run "sync tests" pnpm --filter memnoter-sync test

# iOS build: local only, not in CI
if [ "$quick" = true ]; then
  step "iOS: skipped (--quick)"
elif [ "$(uname)" != Darwin ]; then
  step "iOS: skipped (needs macOS, and CI does not build iOS)"
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
