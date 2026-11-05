---
"@aws-blocks/core": patch
---

Stabilize the core telemetry framework-sink test for opted-out runs: it now checks a private temporary directory, so other tests creating or removing their own sink directories at the same time can no longer make it fail.
