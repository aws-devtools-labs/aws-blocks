---
"@aws-blocks/core": patch
---

Production `cdk deploy` now passes `--revert-drift`, reconciling configuration drift (e.g. introduced by the `cdk watch`/hotswap dev loop) against the CloudFormation template on a full deploy. The sandbox/dev-loop path is unchanged.
