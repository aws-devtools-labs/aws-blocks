---
"@aws-blocks/core": patch
---

feat(core): record each API namespace on its resolved compute (internal)

`ApiNamespace` now records its name on the namespace's resolved compute
(`compute.namespaces`) so later request routing can map a namespace to the
compute that hosts it. This is a CDK-synth-only internal side effect — in the
mock/runtime bundles there is no compute and it is a silent no-op.

The public `ApiNamespace(scope, name, handler)` signature is unchanged and the
returned handler is byte-identical. On the default single-compute app every
namespace is recorded on the stack's default compute. No `{ compute }` overload
is added here (that is the later customer-facing surface).
