---
"@aws-blocks/core": patch
---

Telemetry no longer wipes the committed `stackId` from `.blocks/config.json`, and `secret`/`config` no longer silently use the shared namespace.

- A `.blocks/config.json` saved with a UTF-8 BOM is now read correctly everywhere: the stack name, the `secret`/`config` namespace, telemetry consent, and the telemetry writers.
- Recording the telemetry project ID never rewrites a config it can't parse (invalid JSON, a top-level array, an empty file). The ID is kept for that run only, and `NODE_DEBUG=blocks-telemetry` logs why. Before, the file was replaced with just the telemetry keys and the `stackId` was lost.
- `blocks-telemetry --enable` / `--disable` now exit 1 with an error naming the file when the config can't be parsed, and leave it unchanged. Before, they reported success and either wiped the file or wrote nothing.
- Config writes re-read the file right before writing and replace it atomically (temp file, then rename), so concurrent commands can't truncate it or drop each other's keys.
- `cdk-blocks secret` / `cdk-blocks config` (and `setSecret()`, `listConfig()` and friends) print a warning on stderr when no `stackId` scopes the namespace, so values go to the unscoped `/blocks/secrets` or `/blocks/config` shared by every app without one. When `.blocks/config.json` exists but can't be parsed, they and the CDK synth fail with an error instead of falling back to that shared namespace. An explicit `--prefix` skips the default namespace.
