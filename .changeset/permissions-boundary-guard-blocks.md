---
'@aws-blocks/bb-auth-oidc': patch
'@aws-blocks/bb-compute': patch
'@aws-blocks/bb-container-compute': patch
'@aws-blocks/bb-cron-job': patch
'@aws-blocks/bb-dashboard': patch
'@aws-blocks/blocks': patch
---

test: check `defaults.permissionsBoundary` coverage for AuthOIDC, Compute, ContainerCompute, CronJob and Dashboard

Each of these blocks now has a synth test that sets `defaults.permissionsBoundary`
and fails if any IAM role in any synthesized template, including custom-resource
provider roles, the CronJob scheduler role and the container task execution
role, lacks the boundary or is missing from the `<stack>.blocks-iam.json`
report. No runtime or synth behavior changes.
