---
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/core": patch
---

Report `AuthOIDC` as the parent block of its session store, and assert the rendered chain on the wire.

`buildUserAgentChain()` returns `customUserAgent` pairs, and the AWS SDK escapes `/` inside a pair's value to `-` when it serializes the header, so a `KVStore/<version>` pair reaches the wire as `bb/KVStore-<version>`. Nothing covered the chain inside the rendered header, so a change that stopped it reaching the wire would still have passed. `bb-kv-store`'s request-capture helper now takes a parent scope, and three cases cover the rendered header: the standalone chain, a three-level chain asserted in root-to-leaf order, and that a native client token appends to the chain rather than replacing it.

`AuthOIDC` built its session store with the scope it was given rather than itself, so the store's requests reported only `bb/KVStore` and no owning block. It cannot pass `this`: the store becomes the engine's session store, and the engine is an argument to `super()`. It now passes a parent carrying the block's own name, version and fully-qualified ID, and the store's own ID is shortened to `sessions` so the resulting table name is unchanged.

Both runtimes now use `computeScopeFullId`, the rule every `fullId` getter already applies, re-exported from `@aws-blocks/core/bb-utils` for block authors who build a child before `super()` runs. The helper it replaces walked one scope too far, so under a `Scope` root it derived a leading-dash ID and the runtime read a cookie-secret environment variable name the CDK side never wrote, leaving the secret unresolvable. Reader and writer now derive the name from the same function.
