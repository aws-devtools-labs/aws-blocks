---
"@aws-blocks/core": minor
"@aws-blocks/create-blocks-app": minor
"@aws-blocks/blocks": minor
---

`AWS_BLOCKS_DISABLE_TELEMETRY` now accepts `true` and `yes` in addition to `1` (case-insensitive, trimmed).

Previously only the exact value `1` disabled telemetry, so `AWS_BLOCKS_DISABLE_TELEMETRY=true` kept telemetry on. Both packages now accept `1`, `true` and `yes`; `0`, `false`, empty and unset keep telemetry enabled. The `blocks-telemetry --help` output lists the accepted values, and the D-010 usage note in `docs/DECISIONS.md` is updated to match.

Behavior change (0.x minor = breaking channel): if you already export `AWS_BLOCKS_DISABLE_TELEMETRY=true` or `=yes` for another tool, Blocks telemetry is now disabled where it was previously still on.
