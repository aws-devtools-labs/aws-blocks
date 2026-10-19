---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(core): opt-in permissions boundary on every role AWS Blocks creates, plus a synth-time IAM report

- **`defaults.permissionsBoundary`** (new, optional) attaches an IAM permissions
  boundary to every IAM role AWS Blocks creates: the shared execution role,
  block-owned helper roles, the CDK custom-resource roles blocks cause, and
  `Hosting`'s roles. That includes the Lambda@Edge and CloudFront-monitoring
  roles in the separate `us-east-1` stacks and the cross-region-reference
  provider roles, which CDK's own `@aws-cdk/core:permissionsBoundary` context
  doesn't reach. Pass a policy name, a full policy ARN, or an `iam.IManagedPolicy`:

  ```ts
  defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' }
  ```

  A boundary is a ceiling; it never grants. It's unset in both presets, and
  leaving it unset keeps synthesized templates unchanged. When both this option
  and the CDK context are set, this option wins for Blocks-created roles and
  synth warns.
- **IAM report:** every synth now writes `cdk.out/<stack>.blocks-iam.json`
  (`<stack>.<backendId>.blocks-iam.json` for an embedded `BlocksBackend`). It
  lists every statement on the shared execution role, the managed policies, the
  boundary, and the Building Blocks each statement's resources belong to, plus
  an inventory of every IAM role AWS Blocks created with its boundary and tags as
  the template carries them. The file is sorted and deterministic, so CI
  (continuous integration) can diff it between builds or check every role's
  boundary and tags. It doesn't change the CloudFormation template.
- **Shared multi-app accounts:** the core README has a new section on running
  many apps in one AWS account: an example boundary policy that uses
  attribute-based access control (`${aws:PrincipalTag/app}`) so one policy
  serves every app, the deploy-role conditions that make the boundary
  mandatory, and the limits of the approach.
