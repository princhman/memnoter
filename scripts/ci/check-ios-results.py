import json
import os
import sys


def cases(value):
    if isinstance(value, dict):
        if value.get("nodeType") == "Test Case":
            yield value
        for child in value.values():
            yield from cases(child)
    elif isinstance(value, list):
        for child in value:
            yield from cases(child)


# Known-flaky UI tests: they still run and report, but a failure is a warning,
# not a red check. The user agreed to this on 2026-11-22 so CI stops waiting on
# reruns. Remove a name once its fix has passed CI a few times.
NON_BLOCKING = [
    "testDrawingReturnsWithoutImageSelectionAfterDoneAndClose",
    "testReopeningSameNoteAndRelaunchPreserveEdits",
    "testContentsHierarchyFocusAndUnfocusRestoreWholeNote",
]

suite, path = sys.argv[1:]
tests = list(cases(json.load(open(path))))
if not tests:
    raise SystemExit(f"No native tests ran in {suite}")
failed = [test for test in tests if test.get("result") != "Passed"]
# Only a real failure is forgiven; a skipped or unrun flaky test still blocks.
blocking = [test for test in failed
            if test.get("result") != "Failed" or not any(name in test.get("name", "") for name in NON_BLOCKING)]
for test in failed:
    if test not in blocking:
        message = f"Non-blocking flaky test failed in {suite}: {test.get('name')}"
        print(f"::warning::{message}")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as out:
                out.write(f"- ⚠️ {message}\n")
if blocking:
    raise SystemExit(f"Every blocking native test must pass in {suite}: {blocking}")
required = {
    "navigation": [
        "testTwoNativeDatabasesMergeConcurrentYjsEdits",
        "testContentsHierarchyFocusAndUnfocusRestoreWholeNote",
    ],
    "phone": ["testReopeningSameNoteAndRelaunchPreserveEdits"],
}.get(suite, [])
for name in required:
    if not any(name in test.get("name", "") for test in tests):
        raise SystemExit(f"Required native test did not run in {suite}: {name}")
print(f"{suite}: {len(tests) - len(failed)} passed, {len(failed)} non-blocking failures")
