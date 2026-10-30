---
"@aws-blocks/bb-auth": patch
---

A misspelled `Auth` option suggests the key under the same parent first: `mfa: { type: ['TOTP'] }` suggests `mfa.types` rather than the unrelated `users.attributes[].type`, and likewise for `users.attributes[].types`, `allowBearerAuth.clientId` and `socialProviders.<provider>.clientIds`. A key with no close sibling still points to where it belongs (`mfa.groups` → `users.groups`).
