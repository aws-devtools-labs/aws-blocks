# @aws-blocks/bb-auth-cognito

Authentication backed by Amazon Cognito User Pools. Ships with username/password + MFA (SMS, TOTP, Email OTP), user pool groups for RBAC, custom attributes, device tracking, password reset, and a provider-agnostic state machine that drives the same `<Authenticator>` UI as every other AWS Blocks auth BB.

**When to use:** Production apps that need MFA, RBAC via groups, custom attributes, or device tracking on top of AWS Cognito. This BB lets you use Cognito without writing ~130 lines of boilerplate (raw CDK + JWT verify).

**When NOT to use:** Prototypes or internal tools that just need username/password without Cognito — use `AuthBasic`. Direct OIDC federation without Cognito in the middle — use `AuthOIDC`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { AuthCognito } from '@aws-blocks/bb-auth-cognito';

const scope = new Scope('my-app');
const auth = new AuthCognito(scope, 'auth', {
  passwordPolicy: { minLength: 8, requireDigits: true },
  userAttributes: [{ name: 'department' }],
  groups: ['admins', 'readers'],
  mfa: 'optional',
  mfaTypes: ['TOTP', 'EMAIL'],
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getProfile() {
    const user = await auth.requireAuth(context);
    return { username: user.username, groups: user.groups };
  },

  async adminOnly() {
    const user = await auth.requireRole(context, 'admins');
    return { message: `Welcome, ${user.username}` };
  },
}));

// State machine for the <Authenticator> UI
export const authApi = auth.createApi();
```

> The client namespace is taken from the **export name** you choose here (so `import { authApi } from 'aws-blocks'` matches); the `'auth'` label inside `createApi()` is internal and does not affect the wire namespace.

## Supported auth flows

Cognito advertises several top-level auth flows + a matrix of challenge types. This BB implements the non-SRP / non-custom subset — enough to cover every flow a greenfield app is likely to pick. SRP, device-remembered, and custom-auth flows are tracked follow-ups.

| Top-level auth flow | Status | Notes |
|---|---|---|
| `USER_PASSWORD_AUTH` | ✅ Supported | Default. Classic username + password. |
| `USER_AUTH` | ✅ Supported | Choice-based (password / email-OTP / SMS-OTP). Pass `preferredChallenge` to skip `SELECT_CHALLENGE`. |
| `USER_SRP_AUTH` | ❌ Not yet | SRP key-exchange helpers aren't wired. CDK synth throws. |
| `CUSTOM_AUTH` | ❌ Not yet | Custom-challenge Lambda trigger path. CDK synth throws. |

| Challenge type | Status | When it fires |
|---|---|---|
| `SMS_MFA` | ✅ Supported | SMS MFA on classic sign-in. Requires a verified phone + SNS-wired pool. |
| `SOFTWARE_TOKEN_MFA` | ✅ Supported | TOTP MFA on classic sign-in. |
| `EMAIL_OTP` (MFA) | ✅ Supported | Email MFA on classic sign-in. Pool must have SES-wired email. |
| `SELECT_MFA_TYPE` | ✅ Supported | Multi-factor users pick one. |
| `MFA_SETUP` (TOTP) | ✅ Supported | Pools with `mfa: 'required'`. Auto-runs `AssociateSoftwareToken` → `VerifySoftwareToken` on the first sign-in. |
| `MFA_SETUP` (EMAIL) | ✅ Supported | User submits the address to enroll, then confirms via `EMAIL_OTP`. |
| `MFA_SETUP` (selection) | ✅ Supported | Pool allows both TOTP and EMAIL enrollment. |
| `NEW_PASSWORD_REQUIRED` | ✅ Supported | Admin-created users with `Permanent: false`. |
| `SELECT_CHALLENGE` | ✅ Supported | USER_AUTH first-factor picker. |
| `PASSWORD` (USER_AUTH) | ✅ Supported | Non-SRP password leg of USER_AUTH. |
| `SMS_OTP` | ✅ Supported | USER_AUTH passwordless SMS. |
| `EMAIL_OTP` (USER_AUTH) | ✅ Supported | USER_AUTH passwordless email. |
| `WEB_AUTHN` / passkeys | ✅ Supported | Passkey enrolment + USER_AUTH passkey sign-in. Requires `enablePasskeys: true` and a WebAuthn-configured pool (`webAuthnRelyingParty`); throws `WebAuthnNotEnabled` otherwise. |
| `PASSWORD_SRP` | ❌ Not yet | SRP key-exchange required. |
| `PASSWORD_VERIFIER` / `DEVICE_SRP_AUTH` / `DEVICE_PASSWORD_VERIFIER` | ❌ Not yet | SRP + device-remembered flows. |
| `CUSTOM_CHALLENGE` | ❌ Not yet | Requires `CUSTOM_AUTH`. |

Every unsupported challenge that Cognito might emit returns a typed `ApiError(501)` pointing at the relevant follow-up work, rather than falling through to a vague `InvalidParameterException`.

## Client-facing API

Every method takes `context: BlocksContext` (for cookie I/O) or operates on the session established by `signIn`.

### Sign-up

| Method | Signature | Notes |
|---|---|---|
| `signUp(username, password, options?)` | `Promise<SignUpResult>` | Options: `{attributes?, clientMetadata?}`. Returns `{isSignUpComplete, userId, nextStep?}` with `nextStep.name === 'CONFIRM_SIGN_UP'` — the code-confirmation flow is required. |
| `confirmSignUp(username, code)` | `Promise<ConfirmSignUpResult>` | Confirm with the code from email/SMS. Returns `{isSignUpComplete, nextStep}` with `nextStep.signUpStep` being `'DONE' \| 'COMPLETE_AUTO_SIGN_IN'`. |
| `resendSignUpCode(username)` | `Promise<void>` | Re-deliver the confirmation code. |

### Sign-in + challenge continuation

| Method | Signature | Notes |
|---|---|---|
| `signIn(username, password, context, options?)` | `Promise<SignInResult>` | Returns `{status: 'signedIn', user}` or `{status: 'continueSignIn', nextStep}` (narrow with `if (result.status === 'signedIn')`). On success, sets the session cookie. |
| `confirmSignIn(session, response, context, options?)` | `Promise<SignInResult>` | Advance any challenge. `response` is discriminated: `{ code }` (SMS/TOTP/Email/TOTP-setup), `{ newPassword }` (NEW_PASSWORD_REQUIRED), `{ mfaType }` (MFA selection / setup selection), `{ email }` (EMAIL_SETUP address submit), `{ password }` (USER_AUTH password leg), `{ firstFactor }` (USER_AUTH first-factor pick), `{ credential }` (USER_AUTH passkey assertion — the JSON-encoded `PublicKeyCredential` from `navigator.credentials.get(...)`). Legacy `string` is still accepted and routed to the code branch. |
| `signOut(context, options?)` | `Promise<void>` | `{global: true}` calls `GlobalSignOutCommand` (revokes the refresh token at Cognito). |

See the `SignInResult` and `SignInNextStep` types for the discriminated-union shape.

### Session / identity (`BlocksAuth` interface)

| Method | Returns | Description |
|---|---|---|
| `requireAuth(context)` | `Promise<CognitoUser>` | Throws 401 `NotAuthenticatedException` if no valid session. |
| `checkAuth(context)` | `Promise<boolean>` | Boolean check — no throw. |
| `getCurrentUser(context)` | `Promise<CognitoUser \| null>` | Returns user or `null`. Auto-refreshes expired tokens on AWS; the mock has no refresh-token concept, so an expired access token is treated as dead (session dropped, cookie cleared) and `null` is returned. |
| `requireRole(context, role)` | `Promise<CognitoUser>` | Throws 403 `NotAuthorizedException` if user isn't in the group. |
| `fetchUserAttributes(context)` | `Promise<Record<string, string>>` | Return the signed-in user's attributes (live fetch from Cognito via `GetUserCommand`). |
| `fetchAuthSession(context, options?)` | `Promise<AuthSession>` | Return `{ tokens: { idToken, accessToken }, userSub }` for the signed-in user, or `{ tokens: undefined }` when not signed in. Auto-refreshes if the access token has expired; pass `{ forceRefresh: true }` to rotate unconditionally. Shape mirrors Amplify-JS v6 `AuthSession`. Use when calling a non-AWS Blocks AWS service that needs a Cognito JWT — not for identity checks (use `requireAuth` / `getCurrentUser` for those). |

### User profile mutations

| Method | Description |
|---|---|
| `updatePassword(context, old, new)` | Change password. |
| `updateUserAttributes(context, attrs)` | Update multiple attributes; returns per-attribute outcome (may require confirmation code for email/phone). |
| `updateUserAttribute(context, name, value)` | Update a single attribute. |
| `deleteUser(context)` | Delete the signed-in user. |
| `confirmUserAttribute(context, name, code)` | Confirm an attribute change with the verification code. |
| `sendUserAttributeVerificationCode(context, name)` | Resend verification code for an unverified attribute. |

### Password reset

| Method | Description |
|---|---|
| `resetPassword(username)` | Initiate reset; returns `{isPasswordReset: false, nextStep}`. Silently succeeds for unknown users. |
| `confirmResetPassword(username, code, newPassword)` | Complete reset with the emailed code. |

### MFA setup

| Method | Description |
|---|---|
| `setUpTOTP(context)` | Returns `{sharedSecret}` for the authenticator app / QR code. |
| `verifyTOTPSetup(context, code)` | Confirm TOTP setup with a code from the app. |
| `updateMFAPreference(context, preference)` | Configure per-factor MFA settings. `preference` is a delta `{ sms?, totp?, email? }` where each value is `'ENABLED' \| 'DISABLED' \| 'PREFERRED' \| 'NOT_PREFERRED'`. |
| `fetchMFAPreference(context)` | Read current preference. |

### Device tracking

| Method | Description |
|---|---|
| `fetchDevices(context)` | `AsyncIterable<DeviceRecord>` — paginates automatically. |
| `forgetDevice(context, deviceKey)` | Forget the device identified by `deviceKey` (pull it from `fetchDevices`). |

### Passkeys (WebAuthn)

Requires `enablePasskeys: true` and a WebAuthn-configured pool (`webAuthnRelyingParty`). Enrolment/listing operate on the signed-in session; USER_AUTH passkey *sign-in* is driven through `confirmSignIn` (the `{ credential }` branch above).

| Method | Returns | Description |
|---|---|---|
| `startPasskeyRegistration(context)` | `Promise<StartPasskeyRegistrationResult>` | Begin enrolment for the signed-in user. Returns `credentialCreationOptions` (JSON) for the browser's `navigator.credentials.create(...)`. Throws `WebAuthnNotEnabled` if the pool has no WebAuthn config. |
| `completePasskeyRegistration(context, credential)` | `Promise<CompletePasskeyRegistrationResult>` | Persist the browser-encoded `PublicKeyCredential` (JSON string). Returns `{ credentialId }`. |
| `listPasskeys(context)` | `Promise<PasskeyDescription[]>` | List the signed-in user's registered passkeys (paginates internally). |
| `deletePasskey(context, credentialId)` | `Promise<void>` | Remove a registered passkey by `credentialId`. |

## Admin surface (`auth.admin`)

Server-side admin operations — group membership and user lifecycle — that act on **any** user by `username` (unlike the client methods above, which act on the signed-in user via `context`). These are **opt-in**: pass an `admin` options object to enable the `auth.admin` handle and grant the matching `Admin*` / `List*` IAM. A pool that never opts in has no admin grant — its synthesized role is identical to today.

```typescript
const auth = new AuthCognito(scope, 'auth', {
  groups: ['admins'],
  admin: { actions: ['groups'] },   // enable auth.admin; grant only group Admin* actions
});

// Always gate admin routes behind requireRole — these methods do NOT self-gate.
await auth.requireRole(ctx, 'admins');
await auth.admin.addUserToGroup('alice', 'admins');   // group narrowed via GroupOf<O>
```

- **Compile-time gate.** Without an `admin` options object, `auth.admin` is typed `AdminDisabled` and any access is a compile error whose message names the fix (`construct AuthCognito with { admin: {} }`). The getter also throws at runtime for untyped JS callers.
- **`actions` scopes both the IAM grant and the typed method set.** `actions: ['groups']` grants only the group `Admin*` actions and makes only the group methods typecheck; `['lifecycle']` only the user-lifecycle actions/methods; omitted grants both. The method gate lives in a trailing parameter position (`AdminActionGate`), so calling a method whose action wasn't granted is a **compile error** while `AuthCognito<O>` stays covariant in `O`. Untyped JS callers that reach past the gate additionally fast-fail at runtime with a clear error rather than a cryptic AWS `AccessDenied`.
- **Not an access boundary.** Like every block on the shared backend Lambda, client and admin run under one role. Separation is by API surface + lint, not IAM — gate every admin route with `requireRole`.

**Group membership** (`actions: 'groups'`):

| Method | Returns | Description |
|---|---|---|
| `admin.addUserToGroup(username, group)` | `Promise<void>` | Add a user to a seeded group. `group` narrows to `GroupOf<O>`. Throws `GroupNotFound` for an unseeded group, `UserNotFound` for a missing user. |
| `admin.removeUserFromGroup(username, group)` | `Promise<void>` | Remove a user from a group. |
| `admin.listGroupsForUser(username)` | `Promise<GroupOf<O>[]>` | Groups the user belongs to. |
| `admin.listUsersInGroup(group)` | `Promise<AdminUser[]>` | Members of a group (paginates internally). |

**User lifecycle** (`actions: 'lifecycle'`):

| Method | Returns | Description |
|---|---|---|
| `admin.createUser(username, init?)` | `Promise<AdminUser>` | Create a user. `init`: `{ temporaryPassword?, attributes?, suppressInvite? }`. Conflicts with `UserAlreadyExists`. |
| `admin.deleteUser(username)` | `Promise<void>` | Delete a user (also strips them from every group). |
| `admin.disableUser(username)` / `admin.enableUser(username)` | `Promise<void>` | Toggle sign-in. A disabled user's `signIn` is rejected with `NotAuthorizedException`. |
| `admin.resetUserPassword(username)` | `Promise<void>` | Force the user to set a new password on next sign-in. |
| `admin.setUserPassword(username, password, { permanent })` | `Promise<void>` | Set a password. `permanent: true` clears the force-change flag. |
| `admin.getUser(username)` | `Promise<AdminUser \| null>` | Look up a user, or `null` if absent. |
| `admin.scan()` | `AsyncIterable<AdminUser>` | Enumerate all users (paginates internally). |
| `admin.revokeUserSessions(username)` | `Promise<void>` | Revoke the user's refresh tokens (AWS: `AdminUserGlobalSignOut`; mock: delete session records). New tokens can no longer be minted; see the session-freshness note for when this takes effect. |

> **Session freshness.** A group change does not affect a user's **existing** session until their token refreshes — `requireRole` reads the `cognito:groups` claim, not live state. This is inherent Cognito behavior. The change applies on the next sign-in or `fetchAuthSession({ forceRefresh: true })`.
>
> `admin.revokeUserSessions(username)` revokes the user's **refresh tokens** so no new access tokens can be minted, but it does **not** invalidate an already-issued access token — a Blocks session whose access token is still valid keeps passing `checkAuth` / `requireAuth` until that token expires (verified against live Cognito). It is not an instant kill-switch on AWS. (The mock deletes the session record outright, so it *does* flip immediately there — a known mock-vs-AWS parity difference.) For a hard cap, lower `sessionTtlSeconds` / the access-token validity.

## Options

```typescript
interface AuthCognitoOptions {
  mfa?: 'off' | 'optional' | 'required';
  mfaTypes?: ('SMS' | 'TOTP' | 'EMAIL')[];
  passwordPolicy?: PasswordPolicy;
  userAttributes?: UserAttribute[];
  groups?: (string | { name: string; description?: string; precedence?: number })[];
  selfSignUp?: boolean;
  signInWith?: 'username' | 'email' | 'phone'                // identifier shape, see § Sign-in identifiers
            | ('username' | 'email' | 'phone')[];            // default: ['username', 'email']
  deviceTracking?: { challengeRequiredOnNewDevice?: boolean; deviceOnlyRememberedOnUserPrompt?: boolean };
  userPool?: ExternalUserPoolRef;                          // wrap a pre-existing pool
  authFlowType?: 'USER_PASSWORD_AUTH' | 'USER_SRP_AUTH'    // full union typed for forward compat;
             | 'USER_AUTH' | 'CUSTOM_AUTH';                // USER_PASSWORD_AUTH + USER_AUTH supported; SRP/CUSTOM throw at synth
  preferredChallenge?: 'PASSWORD' | 'EMAIL_OTP'            // USER_AUTH: skip the SELECT_CHALLENGE step
                     | 'SMS_OTP' | 'WEB_AUTHN';
  enablePasskeys?: boolean;                                // provision WebAuthn config on the pool
  webAuthnRelyingParty?: {                                 // required when enablePasskeys is set
    id: string; origins: string[];
    userVerification?: 'required' | 'preferred' | 'discouraged';
  };
  crossDomain?: boolean;                                   // SameSite=None; Secure; Partitioned cookie for cross-site frontends
  logger?: ChildLogger;                                    // optional logger for internal operations
  removalPolicy?: 'destroy' | 'retain';                    // default: destroy (sandbox-friendly)
  featurePlan?: 'lite' | 'essentials' | 'plus';            // default: 'essentials'; pinned to stop UpdateUserPool drift
  sessionTtlSeconds?: number;                              // cookie Max-Age; default 400 days (browser cap)
}

// Mock-only extension — use with the local dev runtime
interface AuthCognitoMockOptions extends AuthCognitoOptions {
  codeDelivery?: CodeDeliveryFn;                           // local-only verification-code capture
}
```

## Sign-in identifiers

The `signInWith` option controls what end users sign in with. It maps to Cognito's `signInAliases` flag map and dictates which sign-up payloads the pool accepts:

| `signInWith`                          | Cognito shape                            | What `signUp(username, ...)` accepts            |
|---|---|---|
| `['username', 'email']` *(default)*   | `AliasAttributes: ['email']`             | A non-email username string. Email also signs in via the alias, but **passing an email here throws** *"Username cannot be of email format, since user pool is configured for email alias."* |
| `'username'`                          | `signInAliases: { username: true }`      | A non-email username string. Email/phone are not aliases. |
| `'email'`                             | `UsernameAttributes: ['email']`          | An email address. Email **is** the username. Pick this for email-only sign-up flows. |
| `'phone'`                             | `UsernameAttributes: ['phone_number']`   | A phone number in E.164 format. Pool needs an SMS sender. |
| `['email', 'phone']`                  | `UsernameAttributes: ['email', 'phone_number']` | Either contact value as the primary identifier. |
| `['username', 'email', 'phone']`      | `AliasAttributes: ['email', 'phone_number']` | Username string; both contacts are sign-in aliases. |

`autoVerify` is derived from `signInWith` automatically (email/phone get auto-verified; username can't be "verified").

> **Backward compatibility.** Changing `signInWith` on a deployed pool is destructive — Cognito rejects the alias-shape transition with `InvalidParameterException`. Pick the right value for your initial deploy.

## Using AuthCognito generically (literal-narrowing with `as const`)

`AuthCognito<const O extends AuthCognitoOptions>` is generic on its options literal. Because the generic is a **`const` type parameter**, TypeScript narrows method signatures to the exact values you configured for **options passed inline** — typos on group names, custom attributes, and MFA factors become compile errors instead of runtime surprises, with no `as const` needed:

```typescript
const auth = new AuthCognito(scope, 'auth', { groups: ['admins', 'readers'] });
await auth.requireRole(ctx, 'admins');   // ✅ narrowed inline — no `as const`
await auth.requireRole(ctx, 'admin');    // ❌ compile error (typo)
```

For an options object **declared separately** in a variable, add `as const` so its literals don't widen before reaching the constructor. The example below uses `as const` for that reason; the narrowing it produces is identical.

```typescript
const options = {
  groups: ['admins', 'readers'] as const,
  userAttributes: [
    { name: 'department', type: 'String' },
    { name: 'employeeId',  type: 'Number' },
  ] as const,
  mfaTypes: ['TOTP', 'EMAIL'] as const,
} satisfies AuthCognitoOptions;

const auth = new AuthCognito(scope, 'auth', options);

// ✅ Typechecks — 'admins' is in the narrowed group union.
await auth.requireRole(ctx, 'admins');

// ❌ Compile error — 'admin' (typo) is not a configured group.
await auth.requireRole(ctx, 'admin');

// ✅ 'custom:department' is in the narrowed AttrOf<O>. Prefixed and
//    unprefixed forms both accept the declared names for writes.
await auth.updateUserAttribute(ctx, 'custom:department', 'platform');
await auth.updateUserAttribute(ctx, 'department',        'platform');

// ❌ Compile error — 'custom:manager' was never declared.
await auth.updateUserAttribute(ctx, 'custom:manager', 'alice');

// ✅ 'totp' is in the narrowed MfaTypeOf<O>.
await auth.updateMFAPreference(ctx, { totp: 'PREFERRED' });

// ❌ Compile error — pool is not configured for SMS MFA.
await auth.updateMFAPreference(ctx, { sms: 'PREFERRED' });
```

**Without `as const` you get today's wide types** — every method accepts the full `string` / Cognito-standard / `'SMS' | 'TOTP' | 'EMAIL'` union. Backward-compatible; opt into narrowing when you want the extra safety.

`CognitoUser<O>` — returned by `requireAuth` / `getCurrentUser` / `requireRole` / `signIn` — narrows the same way:

```typescript
const user = await auth.requireAuth(ctx);
user.groups.includes('admins');   // ✅ ok
user.groups.includes('admin');    // ❌ typo caught at compile time
user.attributes['custom:department']; // ✅ typed as `string | undefined`
```

JWT claim payloads on `fetchAuthSession(ctx)` are typed `Record<string, unknown>` — narrow before use:

```typescript
const session = await auth.fetchAuthSession(ctx);
const sub = session.tokens?.idToken.payload.sub;
if (typeof sub === 'string') { /* … */ }
```

## Porting from Amplify JS v6

`AuthCognito` is source-compatible with Amplify JS v6 `Auth` for every method name and most payload shapes. When we deliberately differ from Amplify, we do it to fit the server-side BFF model AWS Blocks uses.

| Amplify JS v6 | `AuthCognito` | Notes |
|---|---|---|
| `signUp({ username, password, options: { userAttributes } })` | `signUp(username, password, { attributes })` | AWS Blocks flattens Amplify's nested `options.userAttributes` into `attributes`. |
| `confirmSignUp({ username, confirmationCode })` | `confirmSignUp(username, code)` | Positional. |
| `resendSignUpCode({ username })` | `resendSignUpCode(username)` | |
| `signIn({ username, password })` | `signIn(username, password, context)` | AWS Blocks takes the request `context` so it can set the HttpOnly session cookie. |
| `confirmSignIn({ challengeResponse })` | `confirmSignIn(session, response, context, options?)` | Discriminated: `{ code }`, `{ newPassword }`, `{ mfaType }`. |
| `signOut()` | `signOut(context, options?)` | `{ global: true }` calls `GlobalSignOutCommand`. |
| `resetPassword({ username })` | `resetPassword(username)` | |
| `confirmResetPassword({ username, newPassword, confirmationCode })` | `confirmResetPassword(username, code, newPassword)` | |
| `updatePassword({ oldPassword, newPassword })` | `updatePassword(context, oldPassword, newPassword)` | |
| `fetchUserAttributes()` | `fetchUserAttributes(context)` | Live read. Returns `Record<string, string>`; narrows via `as const` on `userAttributes`. |
| `updateUserAttribute({ userAttribute: { attributeKey, value } })` | `updateUserAttribute(context, name, value)` | Flattened. |
| `updateUserAttributes({ userAttributes: { … } })` | `updateUserAttributes(context, attributes)` | |
| `sendUserAttributeVerificationCode({ userAttributeKey })` | `sendUserAttributeVerificationCode(context, name)` | |
| `confirmUserAttribute({ userAttributeKey, confirmationCode })` | `confirmUserAttribute(context, name, code)` | |
| `setUpTOTP()` | `setUpTOTP(context)` | Returns `{ sharedSecret }` (Amplify returns `{ getSetupUri, sharedSecret }` — we keep just the secret). |
| `verifyTOTPSetup({ code })` | `verifyTOTPSetup(context, code)` | |
| `updateMFAPreference({ sms, totp, email })` | `updateMFAPreference(context, { sms, totp, email })` | Same per-factor shape: `'ENABLED' \| 'DISABLED' \| 'PREFERRED' \| 'NOT_PREFERRED'`. At most one `'PREFERRED'` per call. |
| `fetchMFAPreference()` | `fetchMFAPreference(context)` | Returns `{ enabled, preferred }`. |
| `fetchAuthSession()` | `fetchAuthSession(context, options?)` | See § "Session surface" below for the intentional differences. |
| `rememberDevice()` | `rememberDevice(context)` | Works on mock; AWS throws `501` until NewDeviceMetadata plumbing lands. |
| `forgetDevice(device?)` | `forgetDevice(context, deviceKey)` | `deviceKey` is required — no "current device" inference. |
| `fetchDevices()` | `fetchDevices(context)` | Returns `AsyncIterable<DeviceRecord>` (Amplify returns an array). |

### Session surface — why not every Amplify field?

Amplify v6's `AuthSession`:

```ts
interface AuthSession {
  tokens?: { idToken?: JWT; accessToken: JWT; signInDetails?: CognitoAuthSignInDetails };
  credentials?: AWSCredentials;
  identityId?: string;
  userSub?: string;
}
```

AWS Blocks's `AuthSession`:

```ts
interface AuthSession {
  tokens?: { idToken: JWT; accessToken: JWT };
  userSub?: string;
}
```

Deliberate differences:

- **`credentials` / `identityId` omitted** — AWS Blocks uses User Pools only, no Identity Pool. Lambdas call AWS using their own IAM role. Adding these fields would require wiring an Identity Pool, which is a separate Building Block.
- **Refresh token not surfaced** — Amplify v6 agrees on this point. Refresh tokens are long-lived bearer credentials; returning them from `fetchAuthSession` would break AWS Blocks's HttpOnly-cookie security model. The BB uses the refresh token internally for auto-refresh; callers never see it.
- **`idToken` is required**, not optional — AWS Blocks always issues both tokens. Amplify's optional marker covers edge cases like client-credentials flows that AWS Blocks doesn't support.
- **`signInDetails` not exposed** — low-value (`loginId` + `authFlowType`); revisit if callers need it.
- **`JWT.payload` is `Record<string, unknown>`** — forces claim-by-claim narrowing. The HMAC-signed cookie prevents forgery, but individual claim shapes depend on Cognito version + pool config. Narrow with `typeof` before trusting a claim.

## Error Handling

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito';

try {
  await auth.signIn('alice', 'wrong', context);
} catch (e) {
  if (isBlocksError(e, AuthCognitoErrors.NotAuthorized)) {
    // wrong password / unauthorized
  }
}
```

Error names match Cognito's wire-format exceptions, so customers familiar with AWS encounter the same strings. `AuthCognitoErrors` maps an ergonomic constant to each wire-format `error.name` — match on the constant with `isBlocksError`, never on the raw string.

| Constant | Wire-format `error.name` | Thrown when |
|---|---|---|
| `AuthCognitoErrors.NotAuthenticated` | `NotAuthenticatedException` | No valid session — surfaced by `requireAuth` (401). |
| `AuthCognitoErrors.NotAuthorized` | `NotAuthorizedException` | Bad credentials, or the user is not in the group required by `requireRole` (403). |
| `AuthCognitoErrors.UserNotFound` | `UserNotFoundException` | No user with that username/alias. |
| `AuthCognitoErrors.UserAlreadyExists` | `UsernameExistsException` | Username already taken on sign-up. |
| `AuthCognitoErrors.InvalidPassword` | `InvalidPasswordException` | Password doesn't satisfy the pool policy. |
| `AuthCognitoErrors.InvalidParameter` | `InvalidParameterException` | Malformed input or an unsupported request shape. |
| `AuthCognitoErrors.CodeMismatch` | `CodeMismatchException` | Wrong confirmation/MFA code on `RespondToAuthChallenge`. Session stays valid; retriable. |
| `AuthCognitoErrors.ExpiredCode` | `ExpiredCodeException` | Confirmation/MFA code expired. |
| `AuthCognitoErrors.LimitExceeded` | `LimitExceededException` | Per-user attempt limit exceeded (e.g. too many code requests). |
| `AuthCognitoErrors.TooManyRequests` | `TooManyRequestsException` | Request rate-limited by Cognito. |
| `AuthCognitoErrors.TooManyFailedAttempts` | `TooManyFailedAttemptsException` | Too many failed verification attempts. |
| `AuthCognitoErrors.PasswordResetRequired` | `PasswordResetRequiredException` | Sign-in blocked — an admin requires a password reset. |
| `AuthCognitoErrors.UserNotConfirmed` | `UserNotConfirmedException` | User hasn't confirmed sign-up yet. |
| `AuthCognitoErrors.MFAMethodNotFound` | `MFAMethodNotFoundException` | Requested MFA method isn't configured for the user. |
| `AuthCognitoErrors.SoftwareTokenMFANotFound` | `SoftwareTokenMFANotFoundException` | TOTP MFA isn't enabled for the user. |
| `AuthCognitoErrors.GroupNotFound` | `ResourceNotFoundException` | Referenced user-pool group doesn't exist. **Note the non-1:1 mapping — see below.** |
| `AuthCognitoErrors.UnsupportedUserState` | `UnsupportedUserStateException` | Operation invalid for the user's current state (e.g. force-change-password). |
| `AuthCognitoErrors.AliasExists` | `AliasExistsException` | Email or phone alias already in use on another user in this pool. |
| `AuthCognitoErrors.InvalidLambdaResponse` | `InvalidLambdaResponseException` | Cognito Lambda trigger returned a malformed response. |
| `AuthCognitoErrors.UserLambdaValidation` | `UserLambdaValidationException` | Cognito Lambda trigger threw; error wrapped by Cognito. |
| `AuthCognitoErrors.InternalError` | `InternalErrorException` | Rare Cognito-side failure. Safe to retry with backoff. |
| `AuthCognitoErrors.EnableSoftwareTokenMFA` | `EnableSoftwareTokenMFAException` | TOTP code mismatch during `VerifySoftwareToken` (MFA setup). Distinct from `CodeMismatchException`; retriable on the same session. |
| `AuthCognitoErrors.WebAuthnNotEnabled` | `WebAuthnNotEnabledException` | Pool has no `WebAuthnConfiguration` — passkeys disabled. |
| `AuthCognitoErrors.WebAuthnOriginNotAllowed` | `WebAuthnOriginNotAllowedException` | Browser submitted a passkey assertion from a non-allow-listed origin. |
| `AuthCognitoErrors.WebAuthnRelyingPartyMismatch` | `WebAuthnRelyingPartyMismatchException` | Submitted credential's rpId does not match the pool's relying-party config. |
| `AuthCognitoErrors.WebAuthnChallengeNotFound` | `WebAuthnChallengeNotFoundException` | WebAuthn challenge expired or session lost — caller must restart. |
| `AuthCognitoErrors.WebAuthnCredentialNotSupported` | `WebAuthnCredentialNotSupportedException` | Submitted credential type / algorithm not supported by the pool config. |
| `AuthCognitoErrors.WebAuthnClientMismatch` | `WebAuthnClientMismatchException` | Cognito refused the assertion because the client ID does not match. |
| `AuthCognitoErrors.WebAuthnConfigurationMissing` | `WebAuthnConfigurationMissingException` | Pool is missing required `WebAuthnConfiguration` (rpId / origins). |

> **Non-obvious mapping:** `AuthCognitoErrors.GroupNotFound` resolves to `'ResourceNotFoundException'`, **not** a `GroupNotFound*` string. Cognito has no dedicated "group not found" exception, so a missing user-pool group surfaces as the generic `ResourceNotFoundException`. Always match with `isBlocksError(e, AuthCognitoErrors.GroupNotFound)` rather than the literal string so the intent stays clear.

### Branching on the `setAuthState` client path

`isBlocksError` works on a **thrown** error. The recommended client path (`createApi()` → `setAuthState()`) does not throw — it returns an `AuthState` whose `errorName` carries the same structured name. Use `hasAuthError` to branch on the returned state:

```typescript
import { hasAuthError } from '@aws-blocks/core';
import { AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito';

const next = await authApi.setAuthState({ action: 'signIn', username, password });
if (hasAuthError(next, AuthCognitoErrors.NotAuthorized)) {
  // wrong username or password
}
```

Rule of thumb: **throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.** Never match on the human-facing `error` string.

## UI Components

Use the provider-agnostic Authenticator from `@aws-blocks/auth-common/ui` — same shape as for `AuthBasic`:

```typescript
import { Authenticator } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi));
```

The state machine (`createApi()`) handles every challenge type, so the same component drives sign-up, confirm, MFA code entry, MFA-type selection, TOTP/Email setup, and password reset — all without frontend code changes.

## Local Development

Zero AWS required. The mock uses in-memory data stores persisted to `.bb-data/<fullId>/state.json`. Verification codes are captured by the optional mock-only `codeDelivery` hook (no email service needed for sign-up/reset flows in tests). See the `createConfirmedUser` helper in `test-apps/comprehensive/test/auth-cognito.test.ts` for a worked example that provisions users end-to-end via `signUp` + `confirmSignUp`.

### Full demo app

The `auth-cognito` template (`packages/create-blocks-app/templates/auth-cognito/`) is a standalone app that exercises every public method with the narrowed types (`as const` options, narrowed `requireRole`, discriminated `confirmSignIn`, typed `setAuthState`). Scaffold via `npm create @aws-blocks/blocks-app my-auth-app -- --template auth-cognito` and run `npm run dev`. See that template's README for the full feature tour.

Backend sketch (matches the template's `aws-blocks/index.ts`):

```ts
import { ApiNamespace, Scope } from '@aws-blocks/core';
import { AuthCognito } from '@aws-blocks/bb-auth-cognito';

// `as const` on the options unlocks literal narrowing across the API.
const options = {
  passwordPolicy: { minLength: 8, requireDigits: true },
  userAttributes: [
    { name: 'department', type: 'String' as const },
    { name: 'employeeId', type: 'Number' as const },
  ] as const,
  groups: ['admins', 'readers'] as const,
  mfaTypes: ['TOTP', 'EMAIL'] as const,
} as const;

const scope = new Scope('cognito-demo');
const auth = new AuthCognito(scope, 'auth', options);

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async whoAmI() {
    const user = await auth.requireAuth(context);
    // `user.groups` is narrowed to `('admins' | 'readers')[]`.
    // `user.attributes['custom:department']` is typed.
    return { username: user.username, groups: user.groups };
  },
  async adminOnly() {
    // ❌ `'admin'` (typo) would be a compile error.
    const user = await auth.requireRole(context, 'admins');
    return { message: `Welcome, admin ${user.username}` };
  },
  async enableTOTP() {
    // ❌ `{ sms: 'PREFERRED' }` would be a compile error — pool only
    // configured `['TOTP', 'EMAIL']`.
    await auth.updateMFAPreference(context, { totp: 'PREFERRED' });
  },
  async sessionInfo() {
    const session = await auth.fetchAuthSession(context);
    // Discriminate on a string `status` (not a boolean): native-client codegen
    // (Swift/Kotlin/Dart) only builds a proper discriminated union from a
    // single-value string const/enum per arm.
    if (!session.tokens) return { status: 'signedOut' as const };
    // Claims are `unknown` — narrow before using.
    const payload = session.tokens.idToken.payload;
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    return { status: 'signedIn' as const, sub };
  },
}));

export const authApi = auth.createApi();
```

## Scaling & Cost

Cognito scales automatically. Default quotas: 40 sign-ups/sec, 120 sign-ins/sec (adjustable via Service Quotas). Session records live in a nested DynamoDB table (provisioned by this BB); pay-per-request billing, single-digit ms reads. No per-user storage cost from Cognito.

## Security Model

AWS Blocks auth follows the BFF pattern: the browser sends `{username, password}` to the customer's Lambda over TLS; Lambda forwards to Cognito. The customer's Lambda is inside the user's trust boundary by design — same as `AuthBasic`, `AuthOIDC`, NextAuth, Devise, and every server-mediated auth library. Cognito tokens never reach the browser — instead, the BB issues an opaque HMAC-signed session cookie that maps to a server-side `SessionRecord` in a nested `KVStore`.

See the auth-cognito technical design (see source repo) for the full architecture and mock-vs-AWS parity notes.

## Cookies and sessions

The session cookie is an opaque, HMAC-signed pointer to a server-side `SessionRecord` (Cognito tokens never reach the browser). By default it is `HttpOnly; SameSite=Lax` (plus `Secure` off localhost), which is correct for same-origin apps and the local dev proxy.

Set `crossDomain: true` only when the frontend and API are served from **different registrable domains** in production (e.g. frontend on Vercel, API on AWS). That switches the cookie to `SameSite=None; Secure; Partitioned` so it survives the cross-site request:

```typescript
const auth = new AuthCognito(app, 'auth', { crossDomain: true });
```

On plain-HTTP localhost the BB drops `Secure` for the `Lax` default and drops `Partitioned` for the cross-domain recipe (CHIPS requires HTTPS). The auto-sign-in bridge cookie follows the same policy.



## See Also

- [`@aws-blocks/bb-auth-basic`](../bb-auth-basic/README.md) — Simple username/password for prototypes.
- [`@aws-blocks/auth-common`](../auth-common/README.md) — Shared `BlocksAuth` interface and `<Authenticator>` UI.
