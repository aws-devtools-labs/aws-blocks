---
"@aws-blocks/core": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/blocks": patch
---

feat(core): constructor-forced VPC requirements, lazy VPC, and Database subnet control

Continues the VPC review follow-ups (net-new, unreleased VPC feature).

**Building Blocks declare VPC requirements via the constructor, not a method.**
`BuildingBlockScope` is no longer abstract: its constructor takes the block's VPC
requirements (a value, or a callback for values that depend on `fullId`) and
registers them in a central per-stack registry. This keeps the compile-time
forcing the previous `abstract getVpcRequirements()` provided — a block can't
silently omit its requirements — without a standing method on every subclass, and
gives the framework one place to read, deduplicate, and answer "does anything here
need a VPC?". All Building Blocks were migrated to pass requirements to `super()`.

**VPC is now a derived resource, not a hard prerequisite.** A block that cannot
function without a VPC declares `requiresVpc: true`; when one is needed and the
customer didn't bring their own, Blocks lazily creates a single shared VPC
(generalizing the create-if-absent behavior `bb-data` already used for Aurora) and
emits a notice about the NAT cost. Passing `vpc: { network }` remains the
bring-your-own override.

**`Database` accepts an optional `subnets` placement.** A CDK-free mirror of
`ec2.SubnetSelection` (tier as a string, subnets by id) lets you steer where the
Aurora cluster lands — for a bring-your-own VPC that lacks an isolated tier, or a
compliance requirement to use specific subnets. Omit it to keep the default
(prefer isolated, fall back to `private-with-egress`).
