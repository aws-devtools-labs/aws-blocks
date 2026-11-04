---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

chore(hosting): run the package's unit tests in one process

`npm test` in `@aws-blocks/hosting` now passes `--experimental-test-isolation=none`, so its ~1,700 tests share one Node process instead of one per test file (125 s → 70 s on 4 cores). No runtime change.
