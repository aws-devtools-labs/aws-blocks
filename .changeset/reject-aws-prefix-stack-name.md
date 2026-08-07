---
"@aws-blocks/core": patch
---

Reject stack names starting with "aws" (case-insensitive) at CDK synth time with a clear, actionable error message. AWS reserves this prefix for resource names across Resource Groups, IAM, and other services — a stack name starting with "aws" causes a cryptic CloudFormation deployment failure. The new build-time validation catches this early and tells users exactly what to change (the `stackId` in `.blocks/config.json`).
