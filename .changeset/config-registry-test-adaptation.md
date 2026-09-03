---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-knowledge-base": patch
---

test: adapt CDK tests to the new config-registry finalize signature

Test-only change: both packages' CDK tests were updated to call
`finalizeConfigRegistry` with its new `(root, executionRole, computes)`
signature. No runtime or public API change.
