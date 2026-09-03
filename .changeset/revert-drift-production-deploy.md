---
"@aws-blocks/core": patch
---

Production `cdk deploy` now passes `--revert-drift`, reconciling configuration drift (e.g. introduced by the `cdk watch`/hotswap dev loop) against the CloudFormation template on a full deploy. The sandbox/dev-loop path is unchanged.

Requires an `aws-cdk` CLI new enough to expose `--revert-drift`; the pinned `^2.1138.0` is the validated floor (`--revert-drift` is unavailable on older CLIs, where it would surface as an unknown option). A hermetic real-CDK probe runs the production deploy argv — `--revert-drift` included — against exactly that pinned CLI and asserts it parses (reaching the credential check, not an unknown-option error), so the flag is proven accepted rather than merely present in the argv.
