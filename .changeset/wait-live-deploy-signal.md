---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

feat: `npm run deploy -- --wait-live` holds `BLOCKS_DEPLOYED` until the new build is actually served

`cdk deploy` returning is not the same as the new frontend build being served.
Two edge windows stay open after CloudFormation reports complete, and emitting
`BLOCKS_DEPLOYED` while either is open lets a caller's immediate self-test hit a
stale bundle and silently miss a regression.

- **New opt-in `--wait-live` flag.** When set, `npm run deploy` only prints
  `BLOCKS_DEPLOYED` once the new build is confirmed live, so a request issued
  immediately after the signal returns the new asset.
- **Per-build config match (the KVS cutover).** Each deploy stamps its build id
  into the runtime config (`/.blocks-sandbox/config.json`) and surfaces it as a
  `HostingBuildId` stack output; the poll declares the config live only when the
  body CloudFront serves carries that exact id, distinguishing the new build from
  a byte-identical config still served by an edge POP routing to the previous
  build during cutover — the common re-deploy case.
- **Invalidation wait (the compute/SSR window).** For a compute deploy the `/*`
  CloudFront invalidation that flushes the previous build's edge-cached SSR HTML
  is fire-and-forget, so CloudFormation returns before it propagates. The deploy
  now surfaces the invalidation id as a `HostingInvalidationId` stack output and,
  under `--wait-live`, polls `GetInvalidation` until `Completed` before signalling
  — closing the window where the edge still serves old SSR HTML (referencing old
  hashed assets → 403). Pure-static deploys issue no invalidation and skip this.
- **Bounded probing.** Each config probe carries a per-request timeout
  (`AbortSignal`), so one stalled response cannot hold the deploy past its budget.
  `--wait-live-timeout=<seconds>` tunes the overall budget (default 180); if
  liveness can't be confirmed in time, the deploy — which itself succeeded — prints
  a clear warning and exits non-zero rather than emitting a false "live" signal.
- **No-op for backend-only apps** (no frontend to verify) and off by default, so the
  existing deploy flow is unchanged unless you opt in.
