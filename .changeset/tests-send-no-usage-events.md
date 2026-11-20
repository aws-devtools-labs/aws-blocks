---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

The unit tests of both packages no longer send usage events. They run with the CDK CLI telemetry opt-out set, and the telemetry tests that turn telemetry back on point it at a local endpoint. No change to the published packages.
