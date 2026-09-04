---
"@aws-blocks/core": minor
---

feat(core): expose `getConfigLocation()` so co-located compute can load the app config

`getConfigLocation(scope)` ensures the shared config bucket exists (created once per stack, memoized on
the config registry) and returns `{ bucketName, key }`. `finalizeConfigRegistry` now uses it for the
handler's `BLOCKS_CONFIG_BUCKET`/`BLOCKS_CONFIG_KEY` + `s3:GetObject` grant (handler behavior unchanged).
A Building Block whose compute runs **as** the shared execution role but outside the Lambda handler
(e.g. the Agent BB's AgentCore Runtime) can now inject the same two vars at construction so its
`loadConfigToProcessEnv()` loads the identical app config — otherwise it would run with empty config and
any config-backed BB a tool touches would fail. IAM is unchanged: the config-read grant is on the shared
role, which such compute inherits.
