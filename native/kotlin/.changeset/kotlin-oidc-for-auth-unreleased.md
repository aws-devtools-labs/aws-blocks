---
---

No release: this removes `OidcClient.forAuth`, which was added after 0.2.0 and never released, along
with the changeset that announced it. Apps get their OIDC client from `getClient()` on the
namespace `auth.createOidcApi()` exports, as they did with `AuthOIDC`.
