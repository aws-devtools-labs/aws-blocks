---
"@aws-blocks/core": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

fix(core): harden VPC integration — scoped endpoint SG, runtime-subnet validation, instructive subnet errors

Second-pass hardening of VPC support based on review feedback.

**Interface endpoints are no longer reachable from the whole VPC.** They now get
a dedicated security group that allows 443 only from the Blocks Lambda SG, and
the endpoints are created with `open: false` to suppress CDK's default
"allow 443 from the entire VPC CIDR" rule. On a bring-your-own VPC this stops
unrelated workloads from reaching every Blocks interface endpoint.

**`VpcRequirements.subnetRole` is replaced by `requiresEgress`.** The old field
was declared but never consumed. `requiresEgress` expresses a real, validated
capability: whether the BB's parent runtime (the shared handler Lambda) must be
able to reach the internet. `finalizeVpc` validates it against the runtime's
actual placement and fails synth with an actionable message on a mismatch — it
never relocates the runtime (that's the customer's explicit choice).
`bb-distributed-data` (DSQL) declares `requiresEgress: true`, turning a
previously silent runtime failure (DSQL in isolated subnets deploys clean, then
every call times out) into a build-time error.

**`VpcContext.selectSubnets` is now instructive.** It takes the requesting BB and
verifies the VPC actually has the requested subnet tier, throwing a BB-named,
actionable error instead of the opaque CDK "no subnet groups" error. It accepts
an explicit `{ fallback }` so a BB can opt into graceful degradation (e.g. Aurora
over the Data API works from `private-with-egress` when there is no isolated
tier); the downgrade is never silent. `bb-data` uses this.

**Other fixes:** Lambda placement now fails fast with an actionable error when a
VPC has no private-with-egress tier and none was specified; `bb-data` drops its
unused 5432 ingress rule (Aurora is reached over the RDS Data API, not a socket);
removed `any` casts from the Lambda props and endpoint/CIDR handling; de-duplicated
the VPC/non-VPC branches in `BlocksStack`.

All pre-1.0 `patch` bumps — no breaking changes to shipped, consumed API
(`subnetRole` had no consumers). The umbrella `@aws-blocks/blocks` re-exports the
affected types.
