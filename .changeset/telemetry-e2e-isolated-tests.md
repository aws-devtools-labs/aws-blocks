---
"@aws-blocks/core": patch
---

fix(telemetry): inherit worker stderr in debug mode for e2e test verification

When `NODE_DEBUG=blocks-telemetry` is set, the telemetry worker subprocess now
inherits the parent's stderr so delivery confirmation (`sent (status=200)`) is
observable. Silent by default. Also adds an isolated E2E telemetry test suite
(`test-apps/telemetry`) that verifies payload structure, delivery to the real
endpoint, disable mechanisms, and per-command success/failure events.
