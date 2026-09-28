---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(hosting): warn when a compute resource pins an end-of-life Node.js runtime

`resolveRuntime` still accepts an explicitly pinned `nodejs18.x` or `nodejs20.x`
(so an existing/deployed function isn't hard-broken at synth), but both are past
their AWS Lambda deprecation dates (Node 18: Apr 2025; Node 20: Apr 2026). It now
emits a CDK synth-time **deprecation warning** for those runtimes, pointing at
`nodejs22.x` / `nodejs24.x` (or omitting the runtime to use the default). A
supported runtime, or omitting it, warns nothing; the accepted set and the
hard error for unrecognized runtimes are unchanged.
