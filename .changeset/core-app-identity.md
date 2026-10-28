---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": minor
---

feat(core): `defaults.app` — an app identity for running many apps in one AWS account, plus `blocks-iam-check` and `blocks-iam-policies`

For platforms that deploy many apps (often written by AI coding agents) into
one AWS account through one pipeline. All of it is opt-in: without
`defaults.app`, synthesized templates are unchanged.

- **`defaults.app: { id, strict? }`** (new, optional). AWS Blocks tags every
  resource and every IAM role it creates `app=<id>` — including the CDK
  custom-resource provider roles that `Tags.of()` doesn't reach — at a priority
  the app's own tagging can't override. It checks that every name it derives
  starts with `<id>-` (name the stack `<id>` or `<id>-…`). The id is 1–32
  lowercase letters and digits, starting with a letter.
- **IAM report:** with `defaults.app` set, `cdk.out/<stack>.blocks-iam.json`
  gains an `app` section and a `violations` list: a role without the
  permissions boundary or the app tag, a grant on a name outside the app's
  prefix, a wildcard grant on a data service, a broad AWS managed policy, or a
  stack or block outside the prefix. With `strict: true`, synth fails on any
  violation.
- **`blocks-iam-check`** (new CLI) for the platform's pipeline: checks the IAM
  report and re-checks the synthesized templates with the same rules, and
  confirms the app is the one the pipeline expects (`--app <id>`). Exits 1 on
  any violation.
- **`blocks-iam-policies`** (new CLI, experimental) generates the shared
  permissions boundary (keyed on `${aws:PrincipalTag/app}`) and the app's
  CloudFormation execution policy from a synthesized app.
- **`create-blocks-app --template platform`** (new template): the api-only
  service with `defaults.app`, the permissions boundary, a `check:iam` script and
  platform rules for coding agents in `AGENTS.md`.
