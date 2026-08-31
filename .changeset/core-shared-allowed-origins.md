---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": patch
---

feat(core): add `allowedOrigins` to `BlocksDefaults`

`BlocksDefaults` gains an `allowedOrigins` field — CORS origin patterns (matched
against the request `Origin` header) the compute's API accepts. `LambdaCompute`
now reads `this.defaults.allowedOrigins` to populate `CORS_ALLOWED_ORIGINS`
(comma-joined, as the runtime parses it) instead of reading the `sandboxMode`
CDK context. The `sandbox` preset allows localhost (so a local dev frontend can
reach a deployed API); `production` allows none.

**Breaking (direct `BlocksDefaults` literal authors only):** `allowedOrigins` is
required. Building the object from `BlocksPresets.sandbox` / `BlocksPresets.production`
(or a spread of one) is unaffected — the presets supply it. Only a hand-written
`BlocksDefaults` literal must add the field.
