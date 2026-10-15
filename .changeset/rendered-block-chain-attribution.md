---
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/blocks": patch
"@aws-blocks/core": patch
---

Report `AuthOIDC` as the parent block of its session store, and assert the rendered chain on the wire.

`AuthOIDC` built its session store with the scope it was given rather than itself, so the store's requests reported only `bb/KVStore` and no owning block. It cannot pass `this`: the store becomes the engine's session store, and the engine is an argument to `super()`. It now passes a parent carrying the block's own name, version and fully-qualified ID, built by the new `buildingBlockParent` helper, and the store's own ID is shortened to `sessions` so the session table name is unchanged.

`core` adds two exports: `computeScopeFullId`, the rule `Scope.fullId` already applies, and `buildingBlockParent`, which wraps it for a block that must construct a child before `super()` has run. Both replace a copy of that rule inside `bb-auth-oidc`. The Cognito env var prefix moves into the package's shared `utils.ts` alongside the cookie-secret name, so the CDK writer and the runtime reader derive both names from one function.

Two names change, in local and other non-Lambda `aws-runtime` runs only, where `BLOCKS_STACK_NAME` is unset and the app's root is a `Scope`. In that case the old helper walked one scope too far and produced a leading-dash ID, so the cookie-secret and Cognito env var names it looked up were not the ones the CDK side wrote, and session cookies were named `oidc_-my-app-auth`. Both now resolve. A deployed Lambda always has `BLOCKS_STACK_NAME` set and is unaffected. Under the default condition, which is what a scaffolded app's dev server resolves, the cookie prefix also changes to `oidc_my-app-auth`, from `oidc_my-app_auth` under a plain root and `oidc__my-app_auth` under a `Scope` root, because the dev entry now names cookies with the same expression as the AWS runtime instead of its own. Existing sessions in those two setups are signed out once.

Nothing covered the chain inside the rendered header, so a change that stopped it reaching the wire would still have passed. `bb-kv-store`'s request-capture helper now takes a parent scope, and `bb-auth-oidc` gains a suite that runs under `--conditions=aws-runtime`, where the session store is the real AWS client, and asserts the captured `user-agent` header carries both blocks root-to-leaf. The CDK suite pins the literal env var names the synth side writes, which nothing checked before, and `core` gains tests for the new helper covering attribution, the official-name gate, and the derived ID.
