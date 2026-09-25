---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

fix(telemetry): use ci-info for CI detection so Taskcluster (`TASK_ID` + `RUN_ID`), Netlify, Vercel, and 40+ other CI providers are identified; also treat npm's `ci/<vendor>` user-agent token as CI, keep the previously checked `CODEBUILD_BUILD_ID`, `JENKINS_URL`, `BITBUCKET_BUILD_NUMBER` and `TASKCLUSTER_ROOT_URL` variables, and honor `CI=false`
