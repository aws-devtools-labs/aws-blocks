---
"@aws-blocks/bb-data": patch
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(bb-data): place shared-VPC Aurora in the subnets the VPC actually has

When `Database` runs inside a bring-your-own VPC, its Aurora cluster was pinned
to `PRIVATE_ISOLATED` subnets. The VPC in every docs example
(`new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 })`) has no isolated
tier, so following the documented setup and adding a `Database` failed synth
with "no isolated subnet groups in this VPC."

Aurora is reached over the RDS Data API (HTTPS via the interface endpoint), not
a raw Postgres socket, so the placement tier does not affect reachability — it
only has to be a tier the VPC actually has. The shared-VPC path now prefers the
isolated tier when the VPC has one (keeping the DB off any NAT path) and falls
back to `PRIVATE_WITH_EGRESS` otherwise, via the VPC context's `selectSubnets`.
The standalone path is unchanged — it still builds its own VPC with a dedicated
isolated tier.

This is a `patch` bump: pre-1.0, where this repo reserves `minor` for breaking
changes. The behavior change only affects the shared-VPC path that previously
failed synth, so it is strictly a fix. The umbrella `@aws-blocks/blocks` gets
the same bump because it re-exports `Database`.

Also adds `Template.fromStack` unit coverage for `finalizeVpc` in
`@aws-blocks/core` — asserting the provisioned `AWS::EC2::VPCEndpoint` set, the
gateway/interface dedup, and the always-on CloudWatch Logs + SSM endpoints —
which previously had no test exercising the provisioning path.
