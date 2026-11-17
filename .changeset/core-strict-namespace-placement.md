---
"@aws-blocks/core": minor
"@aws-blocks/bb-compute": patch
"@aws-blocks/blocks": minor
---

feat(core): `defaults.strictNamespacePlacement` serves each API namespace only on the compute it is placed on

An `ApiNamespace` given its own `compute` is routed to that compute at `/aws-blocks/api/{namespace}`, but the bare `POST /aws-blocks/api` endpoint is served by the default compute and dispatches on the JSON-RPC body. A raw call such as `{ "method": "reports.build" }` to the bare endpoint therefore runs `reports` on the default compute, outside the VPC, container or sizing its placement was meant to give it.

- **New `BlocksDefaults.strictNamespacePlacement`** (`false` in both presets). Add `strictNamespacePlacement: true` to the stack's `defaults`, next to the preset you already use, and each compute's dispatcher serves only the namespaces placed on it, on any RPC path. A call to a namespace placed elsewhere gets the same `-32601` "method not found" error as an unknown namespace. Namespaces without a placement keep running on the default compute, on the bare endpoint and on their own path. The typed TypeScript client and the Kotlin, Swift and Dart clients already call each namespace at its own path, so they keep working. A raw HTTP caller, or a native client generated before per-namespace paths, that posts a placed namespace to the bare endpoint is refused once you turn it on. The option applies only to deployed computes: the local dev server keeps serving every namespace on every path.
- **Every API compute rolls on a change.** The placement map is set in the environment of every compute that serves an API namespace, the default one included, so turning the option on or moving a namespace to another compute updates each function and task definition and no running compute keeps an old map. Synth fails with a clear error if the encoded map is over 2 KB. A compute whose environment has its compute id but no readable map fails to start (a Lambda function retries on the next request) instead of serving every namespace.
- **New synth warning** `blocks:apigateway:bare-endpoint-serves-placed-namespaces` when some namespace runs on its own compute and `strictNamespacePlacement` is off. Turn the option on, or, if raw callers still need the bare endpoint, acknowledge the warning with `Annotations.of(stack).acknowledgeWarning('blocks:apigateway:bare-endpoint-serves-placed-namespaces')` on the stack or backend returned by `create()`.

The option keeps a namespace's code on its own compute and network. It doesn't split IAM: every compute still runs under the app's one execution role.
