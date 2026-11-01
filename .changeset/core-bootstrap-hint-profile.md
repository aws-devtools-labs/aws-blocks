---
"@aws-blocks/core": patch
---

fix(core): the CDK bootstrap command in the "not bootstrapped" message names the profile the deploy uses

`blocks deploy --profile prod` in an account and Region that CDK never bootstrapped printed `npx cdk bootstrap aws://<account>/<region> --app=` without `--profile prod`, so the command bootstrapped the default profile's account, or failed. The hint took its profile from the deployment target, which holds only the `cdk.json` profile or `AWS_DEFAULT_PROFILE`, while `blocks --profile` (and an exported profile) sets `AWS_PROFILE`. It now names the profile CDK deploys with, `AWS_PROFILE` included, and still none when the deploy uses access keys from the environment.
