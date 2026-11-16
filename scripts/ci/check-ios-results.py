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
if not any(test.get("result") == "Passed" for test in tests):
    raise SystemExit(f"No tests passed in {suite}: {tests}")
if suite == "unit":
    # E2E must execute, not silently pass through its worker/Keychain skip.
    e2e = [test for test in tests if "testTwoNativeDatabasesMergeConcurrentYjsEdits" in test.get("name", "")]
    if not e2e or any(test.get("result") != "Passed" for test in e2e):
        raise SystemExit(f"Native sync E2E did not pass: {e2e}")
print(f"{suite}: {sum(test.get('result') == 'Passed' for test in tests)} passed")
