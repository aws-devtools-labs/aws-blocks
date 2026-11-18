---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

chore(hosting): run the package's unit tests in one process

`npm test` in `@aws-blocks/hosting` now passes `--experimental-test-isolation=none`, so its ~1,700 tests share one Node process instead of one per test file (125 s → 70 s on 4 cores). Because a change one file makes to process-wide state now reaches later files, `npm test` also loads a guard (`scripts/test-state-guard.mjs`) that fails the test file which leaves `process.env`, the working directory, `process.exitCode`, or a commonly replaced global (console methods, `process.stdout`/`stderr.write`, `fetch`, timers, `Date`) changed, then restores it for the next file. The guard needs `module.registerHooks` (Node 22.15+); on an older Node 22 it prints one warning and the tests run unguarded. Tests that left `fetch`, `console.warn`, `process.env` or `process.stderr.write` changed now restore them. No runtime change.
