---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/blocks": patch
---

fix(bb-auth-oidc): block stub OIDC provider from non-sandbox deploys

Adds two defense-in-depth guards so a `stubIdp()` provider — which mints
identities with no real credential check and is trivially forgeable — can never
reach a deployed, non-sandbox application:

- **Synth guard** (`index.cdk.ts`): `cdk synth` now fails loudly when a stub
  provider is configured outside sandbox mode (the `sandboxMode` CDK context),
  naming the offending provider and how to resolve it.
- **Runtime guard** (`index.aws.ts`): the AWS runtime refuses to mount stub IdP
  routes in a deployed non-sandbox Lambda, throwing at construction rather than
  silently exposing a forgeable IdP. The sandbox bit is carried from synth to
  runtime through the existing `registerConfig` → S3 config path.

Breaking for any deployed app that declared a stub provider expecting it to run
in production; such a configuration was already an authentication bypass and
must be removed or moved to sandbox mode.
