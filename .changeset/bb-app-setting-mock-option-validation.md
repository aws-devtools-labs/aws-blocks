---
"@aws-blocks/bb-app-setting": patch
---

Validate AppSetting option combinations in local mock, matching CDK synth (#577)

The CDK constructor rejected several invalid option combinations at synth time (`secret` + `schema`, a `schema` with no `value`, `kmsKeyArn` without `secret: true`, an empty `kmsKeyArn`, a `secret` carrying a `value`, an `external` setting with a `value` or without a `name`, and a non-secret with no `value`), but the local mock had none of these checks. `npm run dev` stayed green on config that later failed at `ampx sandbox` or deploy, and a non-secret with no value silently became an empty string.

The synchronous option-combination checks now live in a shared `validateAppSettingOptions()` (`src/validation.ts`, following the `bb-metrics` / `bb-distributed-data` pattern) that both the CDK and mock constructors call, so local dev fails fast with the same `ValidationFailedException`. Async Standard Schema value validation stays in each variant's `put()` path.

Behavior change for local dev: the mock now rejects these combinations instead of accepting them. Any config that relied on the old lax behavior (most notably a non-secret setting declared with no `value`) will now throw locally, as it always would have at synth.
