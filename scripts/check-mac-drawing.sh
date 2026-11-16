#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
check_root=$(mktemp -d /tmp/memnoter-drawing-check.XXXXXX)
trap 'rm -rf "$check_root"' EXIT
check_bundle="$check_root/Memnoter Drawing Checks.app/Contents"
mkdir -p "$check_bundle/MacOS"
# PencilKit's replica manager requires a bundle identifier even in an
# offscreen event/serialization check. No windows or system events are posted.
cat > "$check_bundle/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.memnoter.drawing.checks</string>
<key>CFBundleExecutable</key><string>check</string>
<key>CFBundleName</key><string>Memnoter Drawing Checks</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
xcrun swiftc -parse-as-library -swift-version 6 -target "$(uname -m)-apple-macos14.0" \
  apps/apple-shared/DrawingDocument.swift apps/desktop/native/DrawingSession.swift apps/desktop/native/DrawingCanvas.swift apps/desktop/native/EmbeddedDrawingHost.swift apps/desktop/native/DrawingEditor.swift apps/desktop/native/DrawingPresentation.swift \
  scripts/check-mac-drawing.swift -o "$check_bundle/MacOS/check"
"$check_bundle/MacOS/check" "${1:-$check_root/source.json}"
