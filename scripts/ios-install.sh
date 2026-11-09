#!/bin/bash
# Build the current checkout and install it on the user's physical iPad, then
# relaunch it. Prints the build stamp that Settings → About will show.
#
#   scripts/ios-install.sh               web + native rebuild (Rust core reused)
#   scripts/ios-install.sh --core        also rebuild the Rust core (after crates/ changes)
#
# IOS_DEVICE_ID   default: the user's iPad Air (see `xcrun devicectl list devices`)
# IOS_TEAM_ID     default: the user's development team
set -euo pipefail
cd "$(dirname "$0")/.."

device=${IOS_DEVICE_ID:-00008101-0013399E0CD8001E}
team=${IOS_TEAM_ID:-BVQCX5TLX3}
bundle_id=com.vladyslavnalyvaiko.memnoter.ipad
core=false
for arg in "$@"; do
  case "$arg" in
    --core) core=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! xcrun devicectl list devices 2>/dev/null | grep -q "$device"; then
  echo "Device $device is not connected. Ask the user to connect and unlock it." >&2
  exit 1
fi

core_framework=$(ls -d apps/ios/MemnoterCore/*.xcframework 2>/dev/null | head -1 || true)
if [ "$core" = true ] || [ -z "$core_framework" ]; then
  ./scripts/build-ios-core.sh
fi
./scripts/build-ios-web.sh
(cd apps/ios && xcodegen generate >/dev/null)

log="${TMPDIR:-/tmp}/memnoter-ios-install.log"
echo "Building for $device (log: $log)"
if ! xcodebuild -project apps/ios/Memnoter.xcodeproj -scheme Memnoter \
  -destination "id=$device" -derivedDataPath apps/ios/build-device \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$team" build > "$log" 2>&1; then
  grep -E "error:|BUILD FAILED" "$log" | head -20
  exit 1
fi

xcrun devicectl device install app --device "$device" \
  apps/ios/build-device/Build/Products/Debug-iphoneos/Memnoter.app >/dev/null
xcrun devicectl device process launch --terminate-existing --device "$device" "$bundle_id" >/dev/null

echo "Installed and relaunched. Settings → About should show: build $(cat apps/ios/Resources/Web/build-stamp.txt)"
