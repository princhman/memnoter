#!/bin/bash
# Build the current checkout and install it on the user's physical iPad and/or
# iPhone, then relaunch it. Prints the build stamp that Settings → About will show.
#
#   scripts/ios-install.sh               iPad Air (default)
#   scripts/ios-install.sh --iphone      iPhone 11
#   scripts/ios-install.sh --all         both devices, one build
#   scripts/ios-install.sh --core        also rebuild the Rust core (after crates/ changes)
#
# IOS_DEVICE_ID   overrides the device list (see `xcrun devicectl list devices`)
# IOS_TEAM_ID     default: the user's development team
set -euo pipefail
cd "$(dirname "$0")/.."

ipad=00008101-0013399E0CD8001E
iphone=00008030-000611CC2188C02E
devices=()
team=${IOS_TEAM_ID:-BVQCX5TLX3}
bundle_id=com.vladyslavnalyvaiko.memnoter.ipad
core=false
for arg in "$@"; do
  case "$arg" in
    --core) core=true ;;
    --ipad) devices+=("$ipad") ;;
    --iphone) devices+=("$iphone") ;;
    --all) devices+=("$ipad" "$iphone") ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -n "${IOS_DEVICE_ID:-}" ]; then devices=("$IOS_DEVICE_ID"); fi
if [ ${#devices[@]} -eq 0 ]; then devices=("$ipad"); fi
connected=$(xcrun devicectl list devices 2>/dev/null)
for device in "${devices[@]}"; do
  if ! grep -q "$device" <<<"$connected"; then
    echo "Device $device is not connected. Ask the user to connect and unlock it." >&2
    exit 1
  fi
done

core_framework=$(ls -d apps/ios/MemnoterCore/*.xcframework 2>/dev/null | head -1 || true)
if [ "$core" = true ] || [ -z "$core_framework" ]; then
  ./scripts/build-ios-core.sh
fi
./scripts/build-ios-web.sh
(cd apps/ios && xcodegen generate >/dev/null)

log="${TMPDIR:-/tmp}/memnoter-ios-install.log"
echo "Building for ${devices[*]} (log: $log)"
if ! xcodebuild -project apps/ios/Memnoter.xcodeproj -scheme Memnoter \
  -destination "generic/platform=iOS" -derivedDataPath apps/ios/build-device \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$team" build > "$log" 2>&1; then
  grep -E "error:|BUILD FAILED" "$log" | head -20
  exit 1
fi

for device in "${devices[@]}"; do
  xcrun devicectl device install app --device "$device" \
    apps/ios/build-device/Build/Products/Debug-iphoneos/Memnoter.app >/dev/null
  xcrun devicectl device process launch --terminate-existing --device "$device" "$bundle_id" >/dev/null
  echo "Installed and relaunched on $device"
done

echo "Settings → About should show: build $(cat apps/ios/Resources/Web/build-stamp.txt)"
