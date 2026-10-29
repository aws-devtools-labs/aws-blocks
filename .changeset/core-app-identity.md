---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": minor
"@aws-blocks/hosting": minor
---

feat(core): `defaults.app` — an app identity for running many apps in one AWS account, plus `blocks-iam-check` and `blocks-iam-policies`

For platforms that deploy many apps (often written by AI coding agents) into
one AWS account through one pipeline. All of it is opt-in: without
`defaults.app`, synthesized templates are unchanged.

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
  `eu`, and any id starting with `aws` or `ssm`); synth, both CLIs and the
  platform template reject them, saying why. Keep `.blocks/config.json`'s `stackId` equal to the id, so
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
- **`blocks-iam-check`** (new CLI) for the platform's pipeline: checks the IAM
  report and re-checks every stack template in the assembly (nested assemblies
  and nested stacks included) with the same rules, and confirms the app is the
  one the pipeline expects (`--app <id>`). Exits 1 on any violation, 2 when it
  can't check.
- **`blocks-iam-policies`** (new CLI, experimental) generates, from a
  synthesized app, the shared permissions boundary (an allow-list keyed on
  `${aws:PrincipalTag/app}`), the app's CloudFormation execution policy (one rule
  per exact resource type; it prints the types it has no rule for and the
  accepted CloudFront exceptions, and splits into parts with room for hand
  additions), and a deploy guard that keeps the app's deploy role on its own
  stacks. It warns when the app calls its APIs through `execute-api` (Realtime,
  Agent streaming), which needs a per-app boundary.
- **`create-blocks-app --template platform`** (new template): the api-only
  service with `defaults.app`, the permissions boundary, a `check:iam` script and
  platform rules for coding agents in `AGENTS.md`. With `APP_ID` set, it pins
  the app's bootstrap qualifier and writes the app id as the `stackId`.
- **`HostingConstructProps.edgeStackId`** (new, optional, `@aws-blocks/hosting`):
  the id of the `us-east-1` stack Lambda@Edge functions are hoisted into. AWS
  Blocks' `Hosting` sets it to `<id>-edge` when the fronted backend has
  `defaults.app`, so a shared platform's checks and deploy guard see it as the
  app's own stack.
