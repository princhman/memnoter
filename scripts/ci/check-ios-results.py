import json
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


suite, path = sys.argv[1:]
tests = list(cases(json.load(open(path))))
if not tests or any(test.get("result") != "Passed" for test in tests):
    raise SystemExit(f"Every selected native test must pass in {suite}: {tests}")
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
print(f"{suite}: {sum(test.get('result') == 'Passed' for test in tests)} passed")
