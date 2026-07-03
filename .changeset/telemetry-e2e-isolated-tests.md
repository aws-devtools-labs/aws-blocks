---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

fix(telemetry): inherit worker stderr in debug mode; enable telemetry in CI for create-blocks-app

- When `NODE_DEBUG=blocks-telemetry` is set, the telemetry worker subprocess
  inherits the parent's stderr so delivery confirmation is observable. Silent
  by default.
- Remove CI telemetry suppression from create-blocks-app to match core behavior.
  Telemetry is now enabled in CI (same as all other CLI commands).
- Make `console` cross-platform and headless-safe: pick the OS browser opener
  (`open`/`xdg-open`/`start`), resolve the region from the environment, and treat
  a missing opener (CI / remote shells) as best-effort success instead of failing.
- Add an isolated E2E telemetry test suite (`test-apps/telemetry`) that verifies
  payload structure, delivery to the real endpoint, disable mechanisms, and
  per-command success/failure events.
