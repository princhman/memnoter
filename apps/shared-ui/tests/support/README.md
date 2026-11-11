# Test support

`browserHarness(import.meta.url)` owns the Vite cache, dependency prebundle,
WebKit launcher and cleanup. Always close the server in `after` or `finally`;
closing it also closes any remaining browsers and removes its cache. Dependency
scanning includes the browser fixtures as well as the application's HTML entry
points before a test navigates. The package test command limits file concurrency
to two to avoid exhausting WebKit processes on developer machines and CI.

Pages and contexts created through the harness receive `installTestBridge`.
Pass `{ tauri: { invoke } }` or `{ native: postMessage }` from an init script;
keep scenario-specific responses in the test. Backend transport contract tests
intentionally build their own globals because transport selection is what they
exercise. Node tests receive the `@/` loader once through `support/register.mjs`.

`fixtures/Vault` is deliberately small: a hub with front matter, two topic notes,
two literal fences, three highlights, a table and one PNG. Expected values are
written literally in the folder and storage integration tests. The reading-view
clipboard test supplies literal HTML/plain-text rather than rendering its own
expected value with the production Markdown parser. `bench:large-note` accepts
`LARGE_NOTE_FOLDER` for profiling a larger vault without adding personal files to
the correctness suite. Set `SELECTION_ARTIFACTS` to a directory to save selection
screenshots; otherwise those checks only capture in memory.
