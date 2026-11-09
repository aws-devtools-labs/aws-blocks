---
"@aws-blocks/core": minor
"@aws-blocks/bb-compute": patch
"@aws-blocks/blocks": minor
---

feat(core): `defaults.strictNamespacePlacement` serves each API namespace only on the compute it is placed on

An `ApiNamespace` given its own `compute` is routed to that compute at `/aws-blocks/api/{namespace}`, but the bare `POST /aws-blocks/api` endpoint is served by the default compute and dispatches on the JSON-RPC body. A raw call such as `{ "method": "reports.build" }` to the bare endpoint therefore runs `reports` on the default compute, outside the VPC, container or sizing its placement was meant to give it.

- **New `BlocksDefaults.strictNamespacePlacement`** (off in both presets). With `defaults: { ...BlocksPresets.production, strictNamespacePlacement: true }`, each compute's dispatcher serves only the namespaces placed on it, on any RPC path. A call to a namespace placed elsewhere gets the same `-32601` "method not found" error as an unknown namespace. Namespaces without a placement keep running on the default compute, on the bare endpoint and on their own path. The typed TypeScript client and the Kotlin, Swift and Dart clients already call each namespace at its own path, so they keep working. A raw HTTP caller, or a native client generated before per-namespace paths, that posts a placed namespace to the bare endpoint is refused once you turn it on.
- **New synth warning** `blocks:apigateway:bare-endpoint-serves-placed-namespaces` when some namespace runs on its own compute and `strictNamespacePlacement` is off. Turn the option on, or acknowledge the warning on the stack or backend returned by `create()`.

The option keeps a namespace's code on its own compute and network. It doesn't split IAM: every compute still runs under the app's one execution role.
