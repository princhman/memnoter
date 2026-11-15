#!/bin/bash
# Build the current checkout and install it on the user's physical iPad and/or
# iPhone, then relaunch it. Prints the build stamp that Settings → About will show.
#
#   scripts/ios-install.sh               iPad Air (default)
#   scripts/ios-install.sh --iphone      iPhone 11
#   scripts/ios-install.sh --all         both devices, one build
#   scripts/ios-install.sh --live        use the running pnpm dev:device server
#   scripts/ios-install.sh --core        also rebuild the Rust core (after crates/ changes)
#   scripts/ios-install.sh --question-bank-dev  Debug core + isolated offline bank vault
#
# IOS_DEVICE_ID   overrides the device list (see `xcrun devicectl list devices`)
# IOS_QUESTION_BANK_SEED_DIR  optional offline snapshot directory for --question-bank-dev
# IOS_TEAM_ID     default: the user's development team
set -euo pipefail
cd "$(dirname "$0")/.."

ipad=00008101-0013399E0CD8001E
iphone=00008030-000611CC2188C02E
devices=()
team=${IOS_TEAM_ID:-BVQCX5TLX3}
bundle_id=com.vladyslavnalyvaiko.memnoter.ipad
core=false
live=false
question_bank_dev=false
launch_args=()
for arg in "$@"; do
  case "$arg" in
    --live) live=true ;;
    --core) core=true ;;
    --question-bank-dev) question_bank_dev=true; launch_args+=(--question-bank-dev) ;;
    --ipad) devices+=("$ipad") ;;
    --iphone) devices+=("$iphone") ;;
    --all) devices+=("$ipad" "$iphone") ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -n "${IOS_DEVICE_ID:-}" ]; then devices=("$IOS_DEVICE_ID"); fi
if [ ${#devices[@]} -eq 0 ]; then devices=("$ipad"); fi
live_url=""
if [ "$live" = true ]; then
  live_url=${IOS_EDITOR_DEV_URL:-$(cat .ios-live/url 2>/dev/null || true)}
  if [ -z "$live_url" ] || ! curl --fail --silent --max-time 3 "$live_url/editor.html" >/dev/null; then
    echo "Start pnpm dev:device first (or set IOS_EDITOR_DEV_URL to its URL)." >&2
    exit 1
  fi
fi
connected=$(xcrun devicectl list devices 2>/dev/null)
for device in "${devices[@]}"; do
  if ! grep -q "$device" <<<"$connected"; then
    echo "Device $device is not connected. Ask the user to connect and unlock it." >&2
    exit 1
  fi
done

core_framework=$(ls -d apps/ios/MemnoterCore/*.xcframework 2>/dev/null | head -1 || true)
if [ "$question_bank_dev" = true ]; then
  # Always rebuild: an existing XCFramework may contain a release core, which
  # correctly refuses the bank gate even when the Swift configuration is Debug.
  ./scripts/build-ios-core.sh --debug
  # The bundled editor must understand the same worksheet root as the Debug core.
  export MEMNOTER_QUESTION_BANK_DEV=1
elif [ "$core" = true ] || [ -z "$core_framework" ]; then
  ./scripts/build-ios-core.sh
fi
./scripts/build-ios-web.sh
(cd apps/ios && xcodegen generate >/dev/null)

log="${TMPDIR:-/tmp}/memnoter-ios-install.log"
echo "Building for ${devices[*]} (log: $log)"
if ! xcodebuild -project apps/ios/Memnoter.xcodeproj -scheme Memnoter \
  -destination "generic/platform=iOS" -derivedDataPath apps/ios/build-device \
  -configuration Debug -allowProvisioningUpdates DEVELOPMENT_TEAM="$team" MEMNOTER_EDITOR_DEV_URL="$live_url" build > "$log" 2>&1; then
  grep -E "error:|BUILD FAILED" "$log" | head -20
  exit 1
fi

for device in "${devices[@]}"; do
  xcrun devicectl device install app --device "$device" \
    apps/ios/build-device/Build/Products/Debug-iphoneos/Memnoter.app >/dev/null
  if [ "$question_bank_dev" = true ] && [ -n "${IOS_QUESTION_BANK_SEED_DIR:-}" ]; then
    if [ "$(cat "$IOS_QUESTION_BANK_SEED_DIR/.seed-manifest" 2>/dev/null)" != memnoter-offline-question-bank-seed-v1 ]; then
      echo "Refusing an unmarked question bank seed" >&2; exit 1
    fi
    xcrun devicectl device copy to --device "$device" \
      --domain-type appDataContainer --domain-identifier "$bundle_id" \
      --source "$IOS_QUESTION_BANK_SEED_DIR" --destination Documents/QuestionBankDevelopmentSeed >/dev/null
  fi
  xcrun devicectl device process launch --terminate-existing --device "$device" "$bundle_id" ${launch_args[@]+"${launch_args[@]}"} >/dev/null
  echo "Installed and relaunched on $device"
done

if [ "$question_bank_dev" = true ]; then
  echo "Question bank development: separate seeded/reused offline vault (Application Support/MemnoterQuestionBankDevelopment/v2)."
  echo "Relaunch with --question-bank-dev each time; a Home Screen launch opens the normal vault."
fi

echo "Settings → About should show: build $(cat apps/ios/Resources/Web/build-stamp.txt)"
