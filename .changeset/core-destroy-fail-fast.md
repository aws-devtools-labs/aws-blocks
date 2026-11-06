---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): `destroy` and `sandbox destroy` stop at once on an error that a retry can't fix

- With no AWS Region set, both destroys now stop before running CDK and say to set `AWS_REGION` (or the profile's Region) to the Region the stack was deployed to. Before, the credential pre-check was skipped, and CDK's `UnresolvedAccount` failure was retried for about 3.5 minutes.
- A `cdk destroy` attempt that fails because the AWS account can't be resolved, the Region is missing, or the credentials are missing, expired or rejected is no longer retried. The destroy fails after that attempt.
- `sandbox destroy` now loads `.env.local` before the credential pre-check, as the sandbox deploy does, so an `AWS_PROFILE` or `AWS_REGION` set there is the target that gets checked.
