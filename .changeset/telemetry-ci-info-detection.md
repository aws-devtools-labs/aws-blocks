---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

fix(telemetry): detect CI with ci-info's vendor table so Taskcluster (`TASK_ID` + `RUN_ID`), Netlify, Vercel, and 40+ other CI providers are identified; also treat npm's `ci/<vendor>` user-agent token as CI, keep the previously checked variables, and honor `CI=false`
