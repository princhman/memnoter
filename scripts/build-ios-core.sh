#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export IPHONEOS_DEPLOYMENT_TARGET=17.0
package="$PWD/apps/ios/MemnoterCore"
generated="$PWD/target/ios-bindings"
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build --locked -p memnoter-ffi --lib --release --target "$target"
done
cargo build --locked -p memnoter-ffi --lib
mkdir -p "$generated" "$package/Sources/MemnoterCore"
cargo run --locked -p memnoter-ffi --bin memnoter-bindgen -- generate --library target/debug/libmemnoter_ffi.dylib --language swift --out-dir "$generated"
cp "$generated/memnoter_ffi.swift" "$package/Sources/MemnoterCore/"
cp "$generated/memnoter_ffiFFI.modulemap" "$generated/module.modulemap"
rm -rf "$package/MemnoterFFI.xcframework"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libmemnoter_ffi.a -headers "$generated" \
  -library target/aarch64-apple-ios-sim/release/libmemnoter_ffi.a -headers "$generated" \
  -output "$package/MemnoterFFI.xcframework"
