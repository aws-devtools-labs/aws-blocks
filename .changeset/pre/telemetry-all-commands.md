---
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/hosting": patch
"aws-cdk-blocks": patch
---

Every CLI command now sends one usage event. `sandbox deploy` and `sandbox preview` report under their own names instead of `sandbox`. `generate types --watch` now stops cleanly on Ctrl-C or SIGTERM. A telemetry failure never changes a command's exit code or output, and the CDK CLI telemetry opt-out still turns all of it off.
