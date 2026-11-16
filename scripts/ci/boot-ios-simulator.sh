#!/usr/bin/env bash
set -euo pipefail
xcodebuild -version
xcrun simctl list devices available --json > "$RUNNER_TEMP/simulators.json"
simulator_id=$(python3 - "$RUNNER_TEMP/simulators.json" <<'PYTHON'
import json, subprocess, sys
sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], text=True).strip()
runtime = "com.apple.CoreSimulator.SimRuntime.iOS-" + sdk.replace(".", "-")
devices = json.load(open(sys.argv[1]))["devices"].get(runtime, [])
ipads = sorted((d for d in devices if d["name"].startswith("iPad")), key=lambda d: (d["name"], d["udid"]))
if not ipads:
    raise SystemExit(f"No installed iPad for SDK {sdk}: {devices}")
print(ipads[0]["udid"])
PYTHON
)
echo "IOS_SIMULATOR_ID=$simulator_id" >> "$GITHUB_ENV"
xcrun simctl boot "$simulator_id"
