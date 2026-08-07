---
"@aws-blocks/core": patch
---

Reject stack names starting with "aws" (case-insensitive) at CDK synth time with a clear, actionable error message. AWS reserves this prefix for Resource Group names — deploying a stack named "aws-..." fails when CloudFormation creates the stack's Resource Groups. The new build-time check catches this immediately and directs users to rename the stackId in `.blocks/config.json`.
