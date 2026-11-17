---
"aws-blocks-kotlin": minor
---

Add OIDC sign-in support for the iOS and JVM targets. iOS uses
ASWebAuthenticationSession; JVM receives the relay redirect on a loopback address it
binds per sign-in, so desktop apps need no relay configuration. The `oidc { redirectUrl }`
Gradle property is renamed to `relayTo`, matching the backend's `allowedRelayOrigins`;
the old name still works with a deprecation warning.
