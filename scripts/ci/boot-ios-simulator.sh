#!/usr/bin/env bash
set -euo pipefail
xcodebuild -version
xcrun simctl list devices available --json > "$RUNNER_TEMP/simulators.json"
simulator_id=$(python3 - "$RUNNER_TEMP/simulators.json" "${1:-iPad}" <<'PYTHON'
import json, subprocess, sys
family = sys.argv[2]
if family not in ("iPad", "iPhone"):
    raise SystemExit(f"Unsupported simulator family: {family}")
sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], text=True).strip()
runtime = "com.apple.CoreSimulator.SimRuntime.iOS-" + sdk.replace(".", "-")
devices = json.load(open(sys.argv[1]))["devices"].get(runtime, [])
matches = sorted((d for d in devices if d["name"].startswith(family)), key=lambda d: (d["name"], d["udid"]))
if not matches:
    raise SystemExit(f"No installed {family} for SDK {sdk}: {devices}")
print(matches[0]["udid"])
PYTHON
)
echo "IOS_SIMULATOR_ID=$simulator_id" >> "$GITHUB_ENV"
xcrun simctl boot "$simulator_id"
