---
"aws-blocks-kotlin": patch
---

Ignore an `oidc/client` result's `x-blocks-type-args`, which `blocks-generate-spec`
now fills with the app's provider names, so the generated `OidcClient` result is
unchanged. Turning those names into an unused enum fails code generation for a
provider name such as `login.gov`.
