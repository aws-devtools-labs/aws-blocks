---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(core): emit an OIDC client's inferred provider names

`blocks-generate-spec` now writes `x-blocks-type-args` for an `oidc/client` result
from the provider names the type checker infers, including for a namespace built
in another module. `AuthOIDC.createApi()`'s `getClient()`, typed
`OIDCClient<ProviderName<P>>`, now carries the configured provider names as a
string enum, for example `[{ "type": "string", "enum": ["google", "github"] }]`,
so native clients can generate a provider type. Provider names that resolve to
plain `string` or `any` emit no type args. Other transferables are unchanged.

`@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.
