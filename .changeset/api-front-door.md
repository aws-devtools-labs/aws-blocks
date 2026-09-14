---
"@aws-blocks/core": minor
---

Switch the client to the managed CloudFront **API front door**, add a public option to select it, and reuse a Hosting app's existing distribution instead of provisioning a second one. This builds on the front-door provisioning (the distribution is now the client's origin, not just a deployed-but-unused resource).

- New **`apiFrontDoor?: 'cloudfront' | 'none'`** on `BlocksStack.create` / `BlocksBackend.create` selects how the API is fronted. `'cloudfront'` provisions the managed distribution as the stable public origin; `'none'` leaves the client calling the API Gateway directly. When omitted it follows the preset's `defaults.provisionApiFrontDoor` (on in `production`, off in `sandbox`), so existing apps are unaffected.
- The `ApiUrl` CfnOutput is now **lazy** — it resolves to the API front-door origin when one is provisioned, otherwise the API Gateway URL. The deploy step writes that value into the client's `config.json`, so the switch needs **no client-code change**.
- The front-door aspect gains a **Hosting-reuse** branch: when a `Hosting` construct is present **in the same stack** it already fronts `/aws-blocks/api/*` on its own CloudFront distribution, so the managed API front door reuses it and creates no second distribution. Hosting publishes its distribution via the new `registerHostingDistribution`, and its `addApiBehaviors` reuses `httpOriginFromApiUrl` so both API front-door paths behave identically. Reuse detection is per-stack, so an app whose `Hosting` lives in a **different** stack should pass `apiFrontDoor: 'none'` on the backend and let Hosting front the API — documented in core's README.
- **Deprecated** `BlocksStack.gateway`/`apiUrl` and `BlocksBackend.gateway`/`apiUrl` — the API front door (or a compute's own `apiGateway`) supersedes the stack-level accessors; they are removed in a later change.

Non-breaking (coordinated redeploy — no production traffic changes on merge). Per-namespace routing to multiple computes and the client's per-namespace path segment land with later multi-compute fan-out work.
