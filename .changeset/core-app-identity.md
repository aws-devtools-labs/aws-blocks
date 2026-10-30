---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/hosting": minor
---

feat(core): `defaults.app` — an app identity for running many apps in one AWS account

For platforms that deploy many apps (often written by AI coding agents) into
one AWS account through one pipeline. All of it is opt-in: without
`defaults.app`, synthesized templates are unchanged. The core README section "Running many apps
in one AWS account" shows what a platform puts in its own project template, and
documents the IAM policies the platform writes and owns: a shared permissions
boundary keyed on `${aws:PrincipalTag/app}`, a per-app CloudFormation execution
policy, and a deploy guard.

- **`defaults.app: { id, strict? }`** (new, optional). AWS Blocks tags every
  resource and every IAM role it creates `app=<id>` — including the CDK
  custom-resource provider roles that `Tags.of()` doesn't reach — at a priority
  above the default `Tags.of().add()`. It checks that every name it derives
  starts with `<id>-` (name the stack `<id>` or `<id>-…`), including the
  CloudFront Functions and KeyValueStores it creates. `Hosting` and the separate
  `us-east-1` stacks it adds are tagged too. The id is 1–10 lowercase letters
  and digits, starting with a letter; it is also the app's CDK bootstrap
  qualifier. Some ids are reserved because their `<id>-…` / `<id>/…` names
  would cover names other apps, CDK or AWS share (`cdk`, `blocks`, `secrets`,
  `config`, `amplify`, `cf`, `sagemaker`, the region prefixes such as `us` and
  `eu`, and any id starting with `aws` or `ssm`); synth rejects them, saying
  why. Keep `.blocks/config.json`'s `stackId` equal to the id, so
  Hosting's `secret()` / `config()` values (`blocks/<stackId>/…`) are the app's
  own.
- **IAM report:** with `defaults.app` set, `cdk.out/<stack>.blocks-iam.json`
  gains an `app` section and a `violations` list: a role without the
  permissions boundary or the app tag, a grant on a name outside the app's
  prefix, a wildcard or "everything except" grant on a data service, a resource
  the check can't resolve, a resource policy that opens up another app's
  resource, a role that trusts anything but an AWS service, a broad AWS managed
  policy, or a stack or block outside the prefix. With `strict: true`, synth
  fails on any violation.
- **`HostingConstructProps.edgeStackId`** (new, optional, `@aws-blocks/hosting`):
  the id of the `us-east-1` stack Lambda@Edge functions are hoisted into. AWS
  Blocks' `Hosting` sets it to `<id>-edge` when the fronted backend has
  `defaults.app`, so a shared platform's execution policy and deploy guard see it as
  the app's own stack.
