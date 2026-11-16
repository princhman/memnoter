#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

shopt -s nullglob
bundles=("$RUNNER_TEMP"/ios-tests/Products/*.xctestrun)
if [ "${#bundles[@]}" != 1 ]; then
  echo "Expected one xctestrun bundle, found ${#bundles[@]}" >&2
  exit 1
fi
command=(xcodebuild test-without-building -xctestrun "${bundles[0]}"
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_ID"
  -parallel-testing-enabled NO -resultBundlePath "$RUNNER_TEMP/ios-tests.xcresult")
case "$IOS_TEST_SUITE" in
  unit)
    ./scripts/ensure-sync-vars.sh
    node scripts/ios-test-with-worker.mjs "${command[@]}" -only-testing:MemnoterTests
    ;;
  drawing) "${command[@]}" -only-testing:MemnoterUITests/DrawingUITests ;;
  # Includes future UI classes, so adding a test never silently removes coverage.
  navigation) "${command[@]}" -only-testing:MemnoterUITests -skip-testing:MemnoterUITests/DrawingUITests ;;
  *) echo "Unknown iOS suite: $IOS_TEST_SUITE" >&2; exit 2 ;;
esac
