---
"@aws-blocks/bb-distributed-data": patch
---

fix: clear error when `simulateConflict()` is called outside the local mock

`simulateConflict()` is a test helper that only exists in the local mock. Calling it in the deployed AWS runtime
failed with `db.simulateConflict is not a function`; it now throws an error saying the helper is only available in the
local mock. During `cdk synth` it throws the usual actionable synth-time error.
