#!/bin/bash
# Generate a per-configuration plist. Only opted-in Debug builds get LAN keys.
set -euo pipefail
plist="$DERIVED_FILE_DIR/LiveEditor.plist"
mkdir -p "$DERIVED_FILE_DIR"
cat > "$plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict/></plist>
PLIST
if [ "$CONFIGURATION" != Debug ] || [ -z "${MEMNOTER_EDITOR_DEV_URL:-}" ]; then exit 0; fi
url=${MEMNOTER_EDITOR_DEV_URL%/}
if [[ ! "$url" =~ ^http://[a-zA-Z0-9.-]+:[0-9]+$ ]]; then
  echo 'error: MEMNOTER_EDITOR_DEV_URL must be http://host:port'; exit 1
fi
/usr/libexec/PlistBuddy -c "Add :MemnoterEditorDevURL string $url" "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSLocalNetworkUsageDescription string Connect to the Mac live editor during development.' "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity dict' "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent bool true' "$plist"
