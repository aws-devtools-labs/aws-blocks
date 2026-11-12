---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

fix(bb-auth): fail synth when one `Auth` block's route collides with any route of another

The CDK layer claimed only one sign-in route, the sign-out route and one stub IdP route per block, so synth passed when, for example, one block's `redirects.signOutPath` was `/aws-blocks/auth/session` next to a block on the default paths. The backend then refused to load. Synth now claims every route each block mounts, by method and path, and fails with the same message naming both blocks and the fix. A single block whose own `redirects.callbackPath` or `redirects.signOutPath` lands on another of its routes (for example `signOutPath: '/aws-blocks/auth/exchange'`) fails synth too.
