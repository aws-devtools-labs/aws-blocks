---
"aws-blocks-kotlin": minor
---

Remove the deprecated `cdkBlocks.oidc.redirectUrl` Gradle property

The property was renamed to `relayTo`, matching the backend's `allowedRelayOrigins` and
the wire field, and has since been accepted only with a deprecation warning. Builds that
still set `redirectUrl` now fail to configure; rename the assignment to `relayTo`.
