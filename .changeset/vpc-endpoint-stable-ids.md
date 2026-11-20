---
'@aws-blocks/core': minor
'@aws-blocks/blocks': minor
---

Add `stableEndpointIds` to the VPC options (`defaults.vpc`). When it is `true`, the logical ids of the Blocks-provisioned VPC endpoints come from each service's short name (`VpcGws3`, `VpcIflogs`, ...). They then change only when the set of endpoints changes. By default the ids come from the service's full name, which embeds CDK token sequence numbers, so an unrelated change or an upgrade can shift them, and CloudFormation then replaces the endpoints.

The option defaults to `false`, and existing apps synthesize the same endpoint logical ids as before. It is recommended for new apps. Leave it off for a stack that already has Blocks-provisioned endpoints: turning it on replaces those endpoints once, and that update fails and rolls back, because the new S3 gateway endpoint conflicts with the old one's route and the new CloudWatch Logs interface endpoint conflicts with the old one's private DNS. To adopt it on an existing stack, first deploy with `provisionEndpoints: false`, then deploy with the option on. Compute in the VPC can't reach those services between the two deploys. See `VPC.md`.
