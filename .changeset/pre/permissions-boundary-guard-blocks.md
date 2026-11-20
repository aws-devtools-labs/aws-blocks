---
'@aws-cdk-blocks/bb-auth': patch
'@aws-cdk-blocks/bb-compute': patch
'@aws-cdk-blocks/bb-container-compute': patch
'@aws-cdk-blocks/bb-cron-job': patch
'@aws-cdk-blocks/bb-dashboard': patch
'aws-cdk-blocks': patch
---

test: check `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob and Dashboard

Each of these blocks now has a synth test that sets `defaults.permissionsBoundary`
and fails if any IAM role in any synthesized template, including custom-resource
provider roles, the CronJob scheduler role and the container task execution
role, lacks the boundary or is missing from the `<stack>.blocks-iam.json`
report. No runtime or synth behavior changes.
