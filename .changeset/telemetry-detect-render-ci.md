---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

fix(telemetry): detect Render and Taskcluster as CI

Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
service; Taskcluster sets `TASK_ID` and `TASKCLUSTER_ROOT_URL`. Runs on those
platforms were therefore reported as real user sessions instead of `ci:true`,
inflating user metrics. `RENDER`, `TASK_ID`, and `TASKCLUSTER_ROOT_URL` are now
included in both `isCI()` implementations (`@aws-blocks/core` and
`@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
bump because it re-exports `@aws-blocks/core`.
