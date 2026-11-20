# @aws-cdk-blocks/bb-auth

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since the 0.x releases

- A new package. `Auth` replaces `AuthBasic`, `AuthCognito` and `AuthOIDC` from `@aws-blocks/bb-auth-basic`, `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc`.
- 208115d: `Auth` can now write an audit record for each session lifecycle event.
- 5f55dac: A web frontend served from another origin than its API can sign in with a federated provider.
- 5f55dac: `Auth` can share its user pool with a frontend that signs in directly against Cognito, such as one built with the Amplify client libraries.
- 5f55dac: `AuthBasic`, `AuthCognito` and `AuthOIDC` are removed.
- c95d7c7: `Auth` lets you keep end users from writing an attribute your app relies on for authorization.
- 5f55dac: Show local social and SAML sign-in as unavailable.
- 5f55dac: The local user pool can check authenticator-app (TOTP) codes as Cognito does.
- 5f55dac: `Auth` options: a block-level `store` and one `providers` map.
- 5f55dac: `Auth` has `protect()`, for an API namespace that is deny by default.
- 5f55dac: Accept a `Secret` as a provider client secret.
- 5f55dac: `Auth` can send its user pool's email through your own Amazon SES identity, with the `email` option.
- 5f55dac: A sandbox deployment serves the stub IdP.
- 5f55dac: Add auth test helpers to `aws-cdk-blocks/utils`.
- 5f55dac: A signed-in user can set up an authenticator app (TOTP) through `auth.createApi()`, with no backend code.
- 5f55dac: Add `Auth` (`@aws-cdk-blocks/bb-auth`), the single authentication Building Block, exported from `aws-cdk-blocks`.
- 5f55dac: Add `npx @aws-cdk-blocks/bb-auth users`, a supported way to make the first admin.
- 5f55dac: `validateUser` also guards users created outside your app, through a Cognito PreSignUp trigger.
- 5dfe778: Add `auth.createOidcApi()`, the native SDKs' OIDC client.
- 522032d: App clients get explicit token lifetimes and refresh-token rotation, and the default session lasts 30 days.
- 703238f: The scaffolded backend folder is `cdk-blocks/` instead of `aws-blocks/`.
- 45a05d1: The per-deploy state directory is now `.cdk-blocks-sandbox/`.
- 1de6ea4: The reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*` and others). `/aws-blocks/` still works as an alias.
- 93d533a: Add `allowPlainHttp`, an explicit opt-out for builders who need a plain-HTTP front door in production.
- adb6077: A production synth fails for a front door that would carry sign-in, session cookies or the origin-verify secret over plain HTTP. To keep such a door, set `allowPlainHttp`.
- 6d3077e: The session store has a new table, on the new `KVStore` layout.
- fc57730: The `session-secret` (the HMAC key that signs session cookies and sign-in challenges) now follows `defaults.secretsStore`.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- 6ae587a: The READMEs document `Auth` setup, options, and error handling, and the `auth-common` README lists the auth error names. They note that sessions default to 30 days and that users sign in again after migrating from `AuthCognito`.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: **Breaking: every published package moves from the `@aws-blocks` scope to `@aws-cdk-blocks`, and `@aws-blocks/blocks` becomes the unscoped `aws-cdk-blocks`.**

  To upgrade:

  1. In `package.json`, replace `@aws-blocks/blocks` with `aws-cdk-blocks` and every other `@aws-blocks/` name with `@aws-cdk-blocks/`, for example `@aws-cdk-blocks/core`.
  2. Make the same replacement in the specifier of every import.
  3. Change each `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the `@aws-cdk-blocks/` prefix, or `cdk synth --strict` fails on the warning.
  4. Keep the CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` in `cdk.json` as it is, because renaming it makes CloudFormation replace the cluster.
  5. If you publish a block, move its dependency from `@aws-blocks/core` to `@aws-cdk-blocks/core`.

  No export or option moved, and the old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- 208115d: Adds `audit: true` to `Auth`, which writes one JSON log line for every session issued, failed sign-in, sign-out, and session revocation. The option is off by default, and records never contain a password, code, token, session id, or error message.
- 5f55dac: Adds `createAuthClient()` in the new `@aws-cdk-blocks/bb-auth/browser-client` entry, for a web frontend served from another origin than its API. It replaces `AuthOIDC`'s `getClient()` browser client, and the README section "Frontend on a different origin" lists the backend settings.
- 5f55dac: Adds `users.caseSensitive`, `allowBearerAuth: { clientIds }`, and `user.federatedIdentity`, so `Auth` can share its user pool with a frontend that signs in directly against Cognito. The README section "Planning to use Amplify client libraries?" covers them.

- 5f55dac: **Breaking: `AuthBasic`, `AuthCognito`, and `AuthOIDC` are removed, and `Auth` replaces all three.**

  To upgrade:

  1. From your app's root, run `npx @aws-cdk-blocks/bb-auth migrate --dry-run` to preview the changes.
  2. Run `npx @aws-cdk-blocks/bb-auth migrate` to rewrite the files.
  3. Resolve each `TODO(aws-blocks-auth-migrate)` comment and follow `MIGRATION.md` in `@aws-cdk-blocks/bb-auth`.
  4. Keep every block's id exactly as it is, because changing it replaces the user pool and deletes its users.
  5. If you implement `BlocksAuth` yourself, add `requireRole`, which is now required.

  `AuthBasic` users sign up again, `AuthOIDC` users sign in once more, and a `cognitoFederated()` provider's user pool is replaced. Telemetry in `@aws-cdk-blocks/core` counts `Auth` as an official Building Block, and no longer counts the three removed blocks.

- c95d7c7: Adds `UserAttribute.userWritable` to `Auth`, which you set to `false` to stop end users from writing an attribute, and `admin.updateUserAttributes(username, attributes)`. With `userPool: Auth.fromExisting(…)`, declare a custom attribute in `users.attributes` to keep it user-writable.
- 5f55dac: In `npm run dev`, `getAuthState()` marks social, SAML, and `type: 'oidc'` sign-in actions on the default store with a new optional `AuthAction.unavailable` reason. The `Authenticator` renders those buttons disabled, and API clients get a `501` JSON error named `ProviderUnavailableException`.
- 5f55dac: Adds the local-only option `totpVerification: 'rfc6238'`, which makes the local user pool accept only the RFC 6238 code of the user's shared secret instead of any six digits. `totpCodeFor(sharedSecret, time?)` from `aws-cdk-blocks/utils` computes the code an authenticator app would show, for tests.
- 5f55dac: `Auth` takes a block-level `store` and one `providers` map, keyed by provider id and tagged with its `type`. The default `store: 'cognito'` keeps users in a Cognito user pool, and `store: 'builtin'` has no user pool, so your backend verifies each provider itself.
- 5f55dac: Adds `auth.protect`, which returns an `ApiNamespace` that is deny by default. It checks the session before any of its `methods` runs, and a signed-out call to a name that isn't a `public` method gets 401 `NotAuthenticatedException`.
- 5f55dac: A provider's `clientSecret` and Sign in with Apple's `privateKey` accept a string-valued `Secret` as well as an `AppSetting` created with `secret: true`. Create the `Secret` with `generate: true`, then after the first deploy set the real value with `npm run secret` and deploy again.
- 5f55dac: Adds the `email` option to `Auth`, which sends the user pool's email through your own Amazon SES identity and is required for email MFA and `users.preferredChallenge: 'EMAIL_OTP'`. `fromAddress` must be a verified SES identity, and the deploying role needs `iam:CreateServiceLinkedRole`.
- 5f55dac: `stubIdp()` runs in a sandbox deployment as well as in `npm run dev`, and anyone who can reach the sandbox can sign in as any of the stub's users. Restart `npm run sandbox` once after upgrading.
- 5f55dac: Adds the Node-only test helpers `getLastAuthCode` and `createTestClient` to `aws-cdk-blocks/utils`. `getLastAuthCode` returns the verification code the local pool sent to a user, and `createTestClient` returns the app's typed clients with a cookie jar of their own.
- 5f55dac: `setAuthState` from `auth.createApi()` takes `setUpTotp`, `verifyTotpSetup`, `getMfaPreference`, and `updateMfaPreference` actions, and the new `MfaSettings` panel from `aws-cdk-blocks/ui` renders them. Native code that matches exhaustively over the `setAuthState` input needs the four new cases.
- 5f55dac: **Breaking: adds `Auth`, the single authentication Building Block, which replaces `AuthBasic`, `AuthCognito`, and `AuthOIDC`.** Names that `aws-cdk-blocks` exported for the old blocks, such as `stubIdp`, `github`, `PasswordPolicy`, and `SignInResult`, now refer to `Auth`'s versions. See `MIGRATION.md` in `@aws-cdk-blocks/bb-auth` for the per-block steps and the `npx @aws-cdk-blocks/bb-auth migrate` codemod. An `AuthCognito` app that switches to `Auth` with the same block id keeps its user pool, its users, and their sessions.
- 5f55dac: Adds `npx @aws-cdk-blocks/bb-auth users`, with `add-to-group`, `remove-from-group`, and `list-groups`, as a supported way to make the first admin. Without `--stage` or `--stack` it edits the local pool, and every write to a deployed pool needs `--yes`.
- 5f55dac: With `validateUser` set on a pool `Auth` creates, a Cognito PreSignUp trigger runs it for every user Cognito is about to create, including users created outside your app. Cognito waits at most 5 seconds for the trigger, so keep `validateUser` fast.
- 5dfe778: Adds `auth.createOidcApi()`, the native SDKs' OIDC client. Export it as `oidcAuthApi` so Swift, Kotlin, and Dart apps can call `getClient()` as they did with `AuthOIDC`.
- 522032d: `Auth` sets explicit token lifetimes and turns on refresh-token rotation, and the default `session.ttlSeconds` drops from 400 days to 30 days. An app that refreshes with `REFRESH_TOKEN_AUTH` itself should switch to `GetTokensFromRefreshToken` or set `session.refreshTokenRotation: false`.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 45a05d1: **Breaking: the per-deploy state directory `.blocks-sandbox/` is renamed to `.cdk-blocks-sandbox/`.**

  To upgrade:

  1. Update your own references to the directory, such as a `.gitignore` entry, a `cdk.json` `watch.exclude` entry, a CI step, or a script passing `outputsFile`.
  2. In a scaffolded Next.js app, keep `src/app/.blocks-sandbox/config.json/route.ts` where it is and change the path it reads from `.blocks-sandbox/config.json` to `.cdk-blocks-sandbox/config.json`.
  3. Delete `.blocks-sandbox/` once you no longer need it.

  Your state files are copied to the new directory on the first `npm run dev`, `npm run deploy`, `npm run sandbox`, or `npm run destroy` after upgrading.

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

- 93d533a: Adds `allowPlainHttp` to the `alb`, `custom`, and stacked doors, an opt-out for a plain-HTTP front door in production. To keep serving plain HTTP in production, add `allowPlainHttp: true` to the door and acknowledge the `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction` warning.

- adb6077: **Breaking: a production synth fails when a front door would carry sign-in, session cookies, or the router's origin-verify secret over plain HTTP.**

  To upgrade:

  1. For `{ kind: 'alb' }` with an API, add a `certificate` and `features.domain`, or use the CloudFront or stacked door.
  2. For a `{ kind: 'custom', door }` whose URL is `http://`, return an `https://` url.
  3. For `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` with an internet-facing router, give the router a `certificate` and `features.router.domain`, or set `internal: true`.

  A sandbox deploy warns as before, and outside a sandbox `Auth` throws `AuthErrors.InsecureTransport` instead of issuing a session over plain HTTP.

- 6d3077e: **Breaking: `Auth` keeps its sessions in a new table, `<fullId>-session-store`, and nothing reads the old `<fullId>-sessions` table.**

  To upgrade:

  1. Deploy once, and CloudFormation creates the new table and removes the old one from the stack.
  2. If the removal policy of the old table is `retain`, delete the table when the upgrade is done, as described in "The session store" in `MIGRATION.md`.
  3. Call `auth.admin.revokeUserSessions` again if it fails with `BatchIncompleteException`.

  Every user signs in once, and the old table is deleted when its removal policy is `destroy`.

- fc57730: **Breaking: with `BlocksPresets.production`, the `session-secret` moves to a new Secrets Manager secret with a new value, so every signed-in user is signed out once.** To keep the existing key, set `secretsStore: 'ssm'` in `defaults` before you deploy this version. Signed-in sessions end in both cases in this release, because the session store is a new table.

### Patch Changes

- 75c5d98: Copies of `auth.admin` methods are never served over RPC, so a copy such as `{ ...auth.admin }` or a destructured method answers method not found. To serve an admin action, write your own method that checks the caller and then calls `auth.admin`.
- 6eba38b: The `auth.admin` handle is never served over RPC, so exporting it or returning it from an `ApiNamespace` handler answers method not found. Methods you write that call `auth.admin` work as before and still need their own caller check.
- 5f55dac: `admin.scan` checks its filter before it reaches Cognito's `ListUsers`, in the local pool and on AWS alike. The attribute must be one Cognito can search on, and a value that contains a double quote, a backslash, or a control character is refused with `InvalidParameterException`.
- 5f55dac: `Auth` gives the same error for the same invalid sign-up or attribute update under `npm run dev` and on AWS. On a pool with `emailPassword: { selfSignUp: false }`, `signUp` always fails with `401 NotAuthorizedException`.
- 5f55dac: The `Authenticator` renders each action as a `<form>`, and its inputs carry `autocomplete` hints. A `<button>` without a `type` inside a field's `render` override submits the action, so give a button that should not submit `type="button"`.
- 5f55dac: On AWS, `Auth` checks user-attribute values itself before it calls Amazon Cognito. A client that sends a value that isn't a string gets `400 InvalidParameterException`, as under `npm run dev`, instead of `500 InternalErrorException`.
- 5f55dac: When synth refuses a change against the user-pool immutability baseline, the error also covers a change that was synthesized but never deployed. It gives the re-baseline command, `BLOCKS_AUTH_REBASELINE=<fullId>`, for that case.
- 5f55dac: `Auth` checks the values of its boolean options at construction, in `npm run dev`, at synth, and in Lambda alike. A non-boolean value such as `emailPassword: { selfSignUp: 0 }` is rejected with an error that names the option and the value it got.
- 5f55dac: A federated sign-in callback honours `error` and `error_description` only when they carry the `state` of the sign-in in progress. Any other callback gets `InvalidStateException`.
- ac4d4a1: `cdk synth` fails when a route of one `Auth` block collides with any other route, with a message naming both blocks and the fix. A single block whose own `redirects.callbackPath` or `redirects.signOutPath` lands on another of its routes fails synth too.
- 5f55dac: Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. `broadcastAuthChange(user, api)` takes an optional `api` to tag a message the same way.
- 5f55dac: Federated sign-in callbacks compare the returned `state` and the ID token's `nonce` in constant time. A `state` or `nonce` of the wrong length or encoding is rejected with the usual `InvalidStateException` or `IdpErrorException`.
- 5f55dac: `auth.createApi()` is typed by the block's options, so `setAuthState` takes only the actions the configuration supports and `AuthState.user` has the block's own groups and attributes. Adds types such as `AuthActionInputOf<O>`, `AuthStateUser<O>`, and `AuthUserOf<A>`.
- ac4d4a1: `DESIGN.md` and the README say that the native SDKs authenticate with the session cookie `/exchange` sets, not bearer tokens. `Authorization: Bearer` is for a hand-written native or CLI client.
- 5f55dac: `Auth` answers 409 `PasskeysNotEnabledException` for a passkey action on a block without `passkeys`, and 409 `MfaNotEnabledException` for an MFA challenge with MFA off. `AuthErrors` in `@aws-cdk-blocks/auth-common` gains `PasskeysNotEnabled` and `MfaNotEnabled`.
- 5f55dac: The `Authenticator` and `AccountMenuBar` show a signed-in user's email address instead of a generated id. `AuthState.user` has an optional `displayName` for display only, so keep keying data on `userId` or `userSub`.
- 5f55dac: Synth warns with `@aws-cdk-blocks/bb-auth:FirstBaselineWithoutPool` when a block's first baseline records no user pool of its own, because that deploy can delete an existing pool and its users. `MIGRATION.md` says to deploy the codemod's output unchanged first and commit the baseline it writes.
- 5f55dac: When account state is hidden, `Auth` logs at `warn` the answers it withholds from the client on `resendSignUpCode`, `resetPassword`, `confirmSignUp`, and `confirmResetPassword`. The marker that lets the PreSignUp trigger skip a second `validateUser` call is signed with its own key.
- 5f55dac: With `emailPassword.revealExistingUsers` off, the default, `confirmSignUp`, `resendSignUpCode`, `resetPassword`, and `confirmResetPassword` give identical answers for an unknown, an unconfirmed, and an already-confirmed user. Set `revealExistingUsers: true` to get the informative errors.
- 5f55dac: `requireAuth().attributes` and `getCurrentUser().attributes` hold the ID token's string claims, so they don't include `updated_at` or `address`. To read either as a string, call `auth.getUserAttributes(context)`.
- 5f55dac: A failed federated sign-in shows the fixed `IdpErrorException` message `The identity provider '<id>' refused the sign-in.` instead of the identity provider's own error text. The provider's text goes to the server log.
- 5f55dac: `bb-auth migrate` leaves code alone when a name only matches a built-in `Object` member, such as `'constructor'` or `'toString'`. A file that both imports and re-exports an old name keeps the re-export, rewritten to `export { Auth } from '@aws-cdk-blocks/bb-auth'`.
- 5f55dac: `bb-auth migrate` moves `@aws-blocks/bb-auth-cognito/ui` imports to `@aws-cdk-blocks/bb-auth/ui` and renames their names to `Auth`'s, such as `cognitoOverrides` to `authOverrides`. It also follows `import * as blocks from 'aws-cdk-blocks'` and merges old imports that end up on the same module.
- 5f55dac: `bb-auth migrate` keeps two old defaults that `Auth` changed, so a migrated app behaves as before. It writes `emailPassword: { autoSignIn: false }` for `AuthCognito` sign-up and `session: { ttlSeconds: 86_400 }` for `AuthBasic`, whose sessions lasted 24 hours instead of 400 days.
- ac4d4a1: The migration guide gains a "Native apps (Dart, Swift, Kotlin)" section. A native app exports both `auth.createApi()` and `auth.createOidcApi()`, and calls `signIn(provider)` on the OIDC client that `getClient()` returns.
- 5f55dac: Under `npm run dev`, the local user pool keeps an email or phone unique, as Cognito does. `confirmSignUp`, `admin.createUser`, and `updateUserAttributes` can answer `AliasExistsException` when another account already has the email or phone.
- 5f55dac: Under `npm run dev`, `signUp`, `updateUserAttributes`, and `admin.createUser` check user attributes against your user pool's schema, as Amazon Cognito does. An undeclared attribute fails with `InvalidParameterException`, so declare a custom attribute in `users: { attributes: [{ name: 'team' }] }`.
- 5f55dac: Under `npm run dev`, confirming a sign-up verifies only the contact the code was sent to, as Amazon Cognito does. To verify the other one after sign-in, call `auth.sendUserAttributeVerificationCode(context, 'phone_number')` and `auth.confirmUserAttribute(context, 'phone_number', code)`.
- 5f55dac: `requireAuth().attributes` and `getCurrentUser().attributes` don't include `email_verified` or `phone_number_verified`, locally or on AWS. To check whether a user's email or phone number is verified, call `auth.getUserAttributes(context)`.
- ac4d4a1: `createOidcApi().getClient()` also sends `sessionCookieName`, the name of the session cookie this block's `/exchange` sets. A native client that signs out locally can remove only that block's cookie.
- 5f55dac: A misspelled `Auth` option suggests the key under the same parent first. For example, `mfa: { type: ['TOTP'] }` suggests `mfa.types` rather than the unrelated `users.attributes[].type`.
- 5f55dac: `Auth` rejects `emailPassword: false` combined with `passkeys`, `users.deviceTracking`, or `mfa` other than `'off'` when you construct it, in `npm run dev`, at synth, and in Lambda alike. `passkeys` without `users.authFlow: 'USER_AUTH'` is refused the same way.
- 5f55dac: Only the `Auth` block that owns a user pool's PreSignUp trigger answers it, so `validateUser` still runs when another block wraps the pool with `userPool: Auth.fromExisting(…)`. Two `Auth` blocks claiming one user pool's PreSignUp trigger fail `cdk synth`.
- 5f55dac: `Auth`'s deploy-time Lambdas leave no log groups behind after the stack is destroyed.
- 5f55dac: The `Auth` README has a "Recipes" section of complete, compile-checked snippets for MFA with an authenticator app, roles, the first admin, and social sign-in. `@aws-cdk-blocks/bb-auth` ships its `API.md`.
- 5f55dac: `Auth` rejects options it doesn't recognise, so a misspelled or misplaced setting is never silently ignored. The constructor throws an error that names each unknown option's path and the likely intended one.
- 5f55dac: `relayOrigin()`'s `RelayConfigError` keeps its name when it crosses the wire, so `isBlocksError(e, 'RelayConfigError')` matches on the client. Sign-in failures from an identity provider never carry the provider's raw text.
- 5f55dac: Fixes made to `AuthCognito`, `AuthOIDC`, and `AuthBasic` since their last release ship in `Auth`. `Auth` has no `metrics` option, no per-username sign-in lockout, and no `additionalCallbackUrls` or `additionalLogoutUrls` options, and you import `AuthActionInput` from `aws-cdk-blocks`.
- 5f55dac: After `confirmResetPassword` succeeds, every session the user had is rejected with 401 `NotAuthenticatedException`. `updatePassword` and `auth.admin.setUserPassword` leave other sessions signed in, so call `auth.admin.revokeUserSessions(username)` to end them.
- 5f55dac: `Auth` accepts `redirectPath`, `redirects.postSignInPath`, and `redirects.postSignOutPath` only when the path resolves to your app's origin. The sign-in route answers an unsafe `redirectPath` with `400`, and an unsafe `postSignInPath` or `postSignOutPath` fails at construction.
- 5f55dac: `Auth` decides whether its cookies are `Secure` from deploy configuration, never from a request header. Cookies from `npm run sandbox` keep `Secure` even though the page is on `http://localhost`, and `npm run dev` drops it for its loopback requests.
- 5f55dac: `Auth` refreshes a session consistently when requests overlap, and a refresh that completes after `signOut()` no longer restores the session. `signOut()` reports the new `AuthErrors.SignOutIncomplete`, a 503 `SignOutIncompleteException`, when it can't delete the session row.
- 5f55dac: `signIn`, `confirmSignIn`, and `autoSignIn` return `SignInResult<O>`, whose `nextStep` carries only the steps the configuration can produce. An `auth.admin` call without `admin` in the options, or an `updateMfaPreference` factor that `mfa.types` leaves out, is a compile error that names its cause.
- 5f55dac: `signIn`, `confirmSignIn`, and `autoSignIn` fail with `InternalErrorException` naming the step when the user pool returns a step the block's options do not enable. In `npm run dev`, the local pool offers only the factors `mfa.types` lists.
- 5f55dac: The `stubIdp()` provider's authorize endpoint accepts only the stub's own `client_id` and a registered `redirect_uri`, and answers anything else with a `400` error page. Its token endpoint redeems an authorization code once, and a second redemption gets `400 invalid_grant`.
- 5f55dac: The `stubIdp()` provider serves an OIDC end-session endpoint at `/cdk-blocks/auth/idp/<id>/logout`. It redirects only to a registered `post_logout_redirect_uri`, and any other URI or an unknown `client_id` gets a `400` error.
- 5f55dac: `AuthenticatedUser` has an optional `claims` field with the provider's verified claims for users of a `store: 'builtin'` block. Postgres RLS sees the identity provider's raw `sub` as `request.jwt.claims.sub` for those users, as it did with `AuthOIDC`.
- 5f55dac: `Auth` synthesizes when you vendorize it with `npm run vendorize -- Auth`. Synth bundles its deploy-time Lambda handlers from the vendorized source with your app's `esbuild`, and tells you to install it if it is missing.
- 5f55dac: Error messages sent to clients carry a fixed message for each error `name`, such as `Invalid parameter` for `InvalidParameterException`, instead of Amazon Cognito's raw text. The error `name`, HTTP status, and `retriable` are not affected, and Cognito's own text is written to the server log.
- b9ecc99: The README has a new "Password policy" section that covers `emailPassword.passwordPolicy`, each `PasswordPolicy` field and its default, and the `InvalidPasswordException` a client receives.

- c67048e: **Breaking: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block, and `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data`, and `@aws-blocks/data-common` are removed.**

  To upgrade:

  1. Import `Database`, `DatabaseCluster`, `DatabaseErrors`, and `sql` from `aws-cdk-blocks`.
  2. To keep an old `@aws-blocks/bb-data` cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it.
  3. Replace `DistributedDatabase` with a `Database` of the same id, which keeps its cluster.
  4. Replace `Database.fromExisting()` with `DatabaseCluster.fromExisting()`, passed as `cluster`.
  5. Replace `withRLS()` with `asUser()` or `asRole()`, and use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely` for Kysely.
  6. Store the connection string of an existing database with `npm run db -- connect --stage <stage>`, not a `*_DB_URL` or `*_CONNECTION_STRING` environment variable.

  Data is not moved, and `crud()`, `ensureSecrets`, and the `npm run db` commands `pull` and `generate-types` are removed.

- 5f55dac: `getSdkIdentifiers(auth)` for an `Auth` block is typed with optional fields. An `Auth` with `store: 'builtin'` has no user pool and registers none of them, so code that reads `userPoolId` must check that it is defined.
- 0ff1e1f: The Auth docs describe the installed version. The `errorName` example in the auth-common README uses `NotAuthorizedException`, an `AuthErrors` value.
- d01c34c: A new test checks the code samples of every doc shipped in `docs/` against the packages. The bb-auth README's frontend sample matches with `isBlocksError(e, 'NotAuthenticatedException')` from `aws-cdk-blocks/client` instead of importing `AuthErrors` from `aws-cdk-blocks`.
- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is the URL the client called, not the gateway's `execute-api` URL. `getRequestBaseUrl()` is unchanged, and each CloudFront door adds one CloudFront Function to the account.
- 8a5726c: Test-only change that checks `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob, and Dashboard. No runtime or synth behavior changes.
- 2095f31: `ctx.request.url.pathname` is the route path in every environment and no longer includes the API Gateway stage when deployed. If you build an absolute link from it while clients call the API Gateway URL directly, add the stage yourself or build the link from your app's configured origin.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.
