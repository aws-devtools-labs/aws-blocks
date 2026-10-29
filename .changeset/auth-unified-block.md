---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
---

Add `Auth` (`@aws-blocks/bb-auth`), the single authentication Building Block, exported from `@aws-blocks/blocks`. One options object configures email + password (backed by a Cognito user pool, with MFA, passkeys, groups and `requireRole`), social and SAML sign-in federated through Cognito, and OIDC / OAuth 2.0 providers federated directly by your backend — no user pool needed. Methods your configuration doesn't support don't compile. Everything runs locally with no AWS account, and `stubIdp()` gives you an offline identity provider for development.

```ts
import { Auth, Scope } from '@aws-blocks/blocks';

const scope = new Scope('app');
const auth = new Auth(scope, 'auth'); // email + password
export const authApi = auth.createApi();
```

`Auth` replaces `AuthBasic`, `AuthCognito` and `AuthOIDC`. An `AuthCognito` app that switches to `Auth` with the same block id keeps its user pool, its users and their sessions. See `MIGRATION.md` in `@aws-blocks/bb-auth` for the per-block steps and the `npx @aws-blocks/bb-auth migrate` codemod.

`@aws-blocks/blocks` now also exports `AuthErrors`, `isAuthError`, the provider helpers `github()`, `customOauth2()`, `stubIdp()` and `relayOrigin()`, and every `Auth` type, and `@aws-blocks/blocks/ui` adds `Auth`'s typed UI helpers (`authOverrides`, `AuthActionName`, …). `getSdkIdentifiers(auth)` returns the user pool's `{ userPoolId, clientId }` (optional fields: an `Auth` with no user pool registers none).

**Breaking:** these names exported from `@aws-blocks/blocks` now refer to `Auth`'s versions instead of the old blocks': `stubIdp`, `github`, `customOauth2`, `relayOrigin`, `RelayOrigin`, `MappedClaims` (were `AuthOIDC`'s), `PasswordPolicy` (was `AuthBasic`'s), and `AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`, `AdminGetterOf`, `AdminGrants`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `CodeDeliveryDetails`, `CodeDeliveryFn`, `ConfirmSignInOptions`, `DeviceRecord`, `ExternalUserPoolRef`, `GroupAdmin`, `LifecycleAdmin`, `ResetPasswordResult`, `SetPasswordOptions`, `SignInNextStep`, `SignInOptions`, `SignInResult`, `SignUpOptions`, `SignUpResult`, `UpdateAttributeOutcome`, `UserAttribute` (were `AuthCognito`'s). Move to `Auth`'s versions: the old blocks and their packages are removed in this release (see `MIGRATION.md`).
