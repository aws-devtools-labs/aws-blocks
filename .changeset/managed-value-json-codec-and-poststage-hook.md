---
"@aws-blocks/hosting": patch
"@aws-blocks/pipeline": patch
---

feat(hosting,pipeline): managed-value JSON codec + a public per-stage post-deploy hook

**`@aws-blocks/hosting` — managed-value JSON codec.** `secret()`/`config()` markers
are branded with a `Symbol` (and may carry a non-serializable `schema`), so they do
not survive `JSON.stringify`/`JSON.parse` — the brand is dropped and
`isManagedValue()` then returns false. Any consumer that carries a config object
containing markers across a JSON boundary (e.g. serializing per-stage config into a
build environment variable and reading it back in a later phase) now has a lossless
round-trip: `encodeManagedValue`/`decodeManagedValue`, the `managedValueReplacer` /
`managedValueReviver` for use with `JSON.stringify`/`JSON.parse`, plus
`isManagedValueJSON`, `ManagedValueJSON`, and `MANAGED_VALUE_JSON_TAG`. Only the
`kind` + `key` locator identity is transported; a marker's optional `schema` is not
serializable and is intentionally dropped.

**`@aws-blocks/pipeline` — `postStage` hook.** New optional `postStage` prop on
`PipelineProps`. It is invoked once per stage with the stage, its config, and the
resolved pipeline source (`PostStageContext`), and its returned steps are attached
as that stage's post-deploy steps. When the stage also has a `bakeTime`, the bake
step is made to depend on the hook's steps, so baking begins only after they
complete rather than racing them in parallel. This lets a higher-level construct run
a second per-stage deploy phase (one that needs the first phase's outputs) without
matching internal construct names to rediscover the stage's source.

Both additions are backward compatible — new exports and one new optional prop.
