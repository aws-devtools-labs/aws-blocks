---
"@aws-blocks/core": patch
---

Stabilize the core telemetry HTTP tests by waiting for delivery instead of fixed delays and cleaning up their local servers, temporary files and environment even when a test fails or times out.
