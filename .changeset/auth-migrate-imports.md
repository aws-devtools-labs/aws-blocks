---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

What `bb-auth migrate` does with imports:

- `@aws-blocks/bb-auth-cognito/ui` imports move to `@aws-blocks/bb-auth/ui`, and their names are renamed to `Auth`'s (`cognitoOverrides` → `authOverrides`, `CognitoActionName` → `AuthActionName`, `CognitoNextStepName` → `AuthNextStepName`, `CognitoActionFields` → `AuthActionFields`, `CognitoActionOverride` → `AuthTypedActionOverride`, `CognitoAuthenticatorOptions` → `AuthTypedAuthenticatorOptions`) along with every place they're used.
- Names imported from `@aws-blocks/bb-auth-oidc/client` or `/middleware` that `@aws-blocks/bb-auth` also exports move there. The rest (`AuthOIDCClient`, `handle401`, …) stay where they are, with a TODO that names them.
- `import * as blocks from '@aws-blocks/blocks'` is followed: `new blocks.AuthCognito(…)`, `blocks.AuthCognitoErrors`, `blocks.CognitoUser` and the other old names are rewritten, the options are mapped, and the block id is never changed.
- Old imports that end up on the same module are merged into one import.
- An import whose name list would end up empty is left as it is, with a TODO, and the summary lists the file under "needs attention" instead of with the rewritten files.
