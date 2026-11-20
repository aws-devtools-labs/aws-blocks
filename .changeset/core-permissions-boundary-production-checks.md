---
'@aws-blocks/core': minor
'@aws-blocks/blocks': patch
---

feat(core): fail production synth on a permissive or conflicting `defaults.permissionsBoundary`

Outside a sandbox deployment (CDK context `sandboxMode` not set), synth now fails when:

- `defaults.permissionsBoundary` is the AWS managed policy `AdministratorAccess`,
  `PowerUserAccess` or `IAMFullAccess`, which don't meaningfully bound a role.
  Set the new `defaults.permissionsBoundaryAllowPermissive: true` to accept one
  deliberately. In a sandbox it is a warning.
- CDK's `@aws-cdk/core:permissionsBoundary` context names a different boundary
  than `defaults.permissionsBoundary`, so a stricter account-wide boundary is
  never replaced for the roles AWS Blocks creates. Set both to the same policy
  in the same form, or set only one. In a sandbox it stays a warning, and when
  the two are equal nothing is reported.

Production apps that set either combination today and synthesize with a
warning will fail synth after this change.
