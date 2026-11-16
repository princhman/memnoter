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
  drawing) "${command[@]}" -only-testing:MemnoterUITests/DrawingUITests ;;
  phone) "${command[@]}" -only-testing:MemnoterUITests/PhoneNavigationUITests ;;
  # Full native target plus future UI classes, using one boot and test operation.
  navigation)
    ./scripts/ensure-sync-vars.sh
    node scripts/ios-test-with-worker.mjs "${command[@]}" \
      -only-testing:MemnoterTests -only-testing:MemnoterUITests \
      -skip-testing:MemnoterUITests/DrawingUITests -skip-testing:MemnoterUITests/PhoneNavigationUITests
    ;;
  *) echo "Unknown iOS suite: $IOS_TEST_SUITE" >&2; exit 2 ;;
esac
