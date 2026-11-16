#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The default remains the release core. Bank development needs Rust's existing
# debug_assertions gate as well as a Debug Swift app; never enable it in release.
profile=release
cargo_profile=(--release)
case "${1:-}" in
  "") ;;
  --debug) profile=debug; cargo_profile=() ;;
  *) echo "usage: $0 [--debug]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo "usage: $0 [--debug]" >&2; exit 2; fi
export CARGO_BUILD_JOBS=4
export IPHONEOS_DEPLOYMENT_TARGET=17.0
package="$PWD/apps/ios/MemnoterCore"
generated="$PWD/target/ios-bindings"
case "$(uname -m)" in
  arm64) simulator_target=aarch64-apple-ios-sim ;;
  x86_64) simulator_target=x86_64-apple-ios ;;
  *) echo "Unsupported simulator host architecture: $(uname -m)" >&2; exit 1 ;;
esac
for target in aarch64-apple-ios "$simulator_target"; do
  cargo build --locked -p memnoter-ffi --lib ${cargo_profile[@]+"${cargo_profile[@]}"} --target "$target"
done
cargo build --locked -p memnoter-ffi --lib
mkdir -p "$generated" "$package/Sources/MemnoterCore"
cargo run --locked -p memnoter-ffi --bin memnoter-bindgen -- generate --library target/debug/libmemnoter_ffi.dylib --language swift --out-dir "$generated"
cp "$generated/memnoter_ffi.swift" "$package/Sources/MemnoterCore/"
cp "$generated/memnoter_ffiFFI.modulemap" "$generated/module.modulemap"
rm -rf "$package/MemnoterFFI.xcframework"
xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/$profile/libmemnoter_ffi.a" -headers "$generated" \
  -library "target/$simulator_target/$profile/libmemnoter_ffi.a" -headers "$generated" \
  -output "$package/MemnoterFFI.xcframework"
printf '%s\n' "$profile" > "$package/MemnoterFFI.xcframework/memnoter-build-profile"
