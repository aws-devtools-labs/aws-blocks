---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": minor
---

Switch the client to the managed CloudFront **API front door**, and reuse a Hosting app's existing distribution instead of provisioning a second one. This builds on the front-door provisioning (the distribution is now the client's origin, not just a deployed-but-unused resource).

- The `ApiUrl` CfnOutput is now **lazy** — it resolves to the front-door origin when one is provisioned, otherwise the API Gateway URL. The deploy step writes that value into the client's `config.json`, so the switch needs **no client-code change**.
- The front-door aspect gains a **Hosting-reuse** branch: when a `Hosting` construct is present it already fronts `/aws-blocks/api/*` on its own CloudFront distribution, so the managed front door reuses it and creates no second distribution. Hosting publishes its distribution via the new `registerHostingDistribution`, and its `addApiBehaviors` reuses `httpOriginFromApiUrl` so both front-door paths behave identically.
- **Deprecated** `BlocksStack.gateway`/`apiUrl` and `BlocksBackend.gateway`/`apiUrl` — the front door (or a compute's own `apiGateway`) supersedes the stack-level accessors; they are removed in a later change.

Non-breaking (coordinated redeploy — no production traffic changes on merge). Per-namespace routing to multiple computes and the client's per-namespace path segment land with later multi-compute fan-out work.
