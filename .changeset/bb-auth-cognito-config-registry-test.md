---
"@aws-blocks/bb-auth-cognito": patch
---

chore(bb-auth-cognito): adapt the CDK test to the new finalizeConfigRegistry signature

Internal, test-only change: updates the CDK test caller for core's config-registry
retargeting (shared execution role + per-stack computes). No runtime behavior or
public API change.
