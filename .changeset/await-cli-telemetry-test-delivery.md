---
"@aws-blocks/create-blocks-app": patch
---

Stabilize the CLI telemetry HTTP test by waiting for delivery instead of a fixed delay and cleaning up its local server and temporary files even when the test fails or times out.
