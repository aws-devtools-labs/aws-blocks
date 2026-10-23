---
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

fix: closing a local Database or DistributedData engine no longer hangs with PGlite 0.5.10

PGlite 0.5.10's `close()` never resolves while the instance is still initializing. An engine destroyed before its
first query, for example in a test teardown or a process shutting down early, would hang forever. `destroy()` now waits
for PGlite's initialization to settle (or fail) before closing.
