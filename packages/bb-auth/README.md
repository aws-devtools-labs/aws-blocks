# Auth

`Auth` is the single authentication Building Block for AWS Blocks: one import and one options object for email + password, social sign-in, generic OIDC and SAML.

Import it from `@aws-blocks/blocks` (or `@aws-blocks/bb-auth`), and its UI helpers from `@aws-blocks/blocks/ui` (or `@aws-blocks/bb-auth/ui`).

> **Coming from `AuthBasic`, `AuthCognito` or `AuthOIDC`?** `Auth` replaces all three. See [MIGRATION.md](./MIGRATION.md) for before → after code, what happens to deployed user pools, users and sessions, and the codemod.

## Which option and why

Every sign-in method is a key on the same options object, and you can combine them in one block. They differ in what they cost, where they run, and which `Auth` features their users get:

| Option | Configure with | What it's for | Cognito pricing | Works offline in `npm run dev` | Cognito groups / `auth.admin` | MFA | PKCE-only IdPs |
|---|---|---|---|---|---|---|---|
| **Email + password** | `emailPassword` (on by default) | Your own user directory: sign-up with an emailed code, password reset, passkeys | 10,000 free MAUs (none on `'plus'`), then the user pool's feature-plan rate | Yes — a local user pool in `.bb-data/` | Yes | Yes — Cognito MFA through `mfa` (TOTP or SMS; email MFA needs an SES-configured pool via `Auth.fromExisting`) | — |
| **Social** | `socialProviders` (`google`, `apple`, `facebook`, `amazon`) | Consumer "Sign in with Google / Apple / Facebook / Amazon" | Same free tier and rate as email + password | No — sign-in answers an actionable `501` locally; deploy a sandbox to test it | Yes — the user becomes a user-pool user | The provider's — Cognito never challenges a federated user | — |
| **Generic OIDC, `federateVia: 'direct'`** (the default) | `oidcProviders` (plus `github()`, `customOauth2()`, `stubIdp()`) | Okta, Entra ID, Auth0, GitHub or any other OIDC / OAuth 2.0 provider, verified by your own backend | No Cognito charge — these users never touch Cognito | Yes — with `stubIdp()`, a real OIDC provider served by the dev server | No pool record: `requireRole()` reads groups from the provider's `groupsClaim`; `auth.admin` does not apply | The provider's | Yes — omit `clientSecret` |
| **Generic OIDC, `federateVia: 'cognito'`** | `oidcProviders` entry with `federateVia: 'cognito'` | The same providers, when you need their users in your Cognito user pool | Separate federated meter: 50 free MAUs, then $0.015 per MAU on every feature plan | No — `501` locally, like social | Yes — the user becomes a user-pool user | The provider's — Cognito never challenges a federated user | No — Cognito requires a client secret |
| **SAML** | `samlProviders` | Enterprise IdPs that only speak SAML 2.0 | Same separate meter as `federateVia: 'cognito'`: 50 free MAUs, then $0.015 per MAU | No — `501` locally, like social | Yes — the user becomes a user-pool user | The provider's — Cognito never challenges a federated user | — (SAML has no PKCE) |

MAU = monthly active user. Prices are from [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) as read on 4 October 2026; check it before you ship. The feature-plan rate depends on `featurePlan`: `'essentials'` (the default) is $0.015 per MAU above the 10,000-MAU free tier, `'lite'` is $0.0055 but cannot run passkeys, passwordless sign-in or email MFA, and `'plus'` is $0.020 per MAU with no free tier. Users who sign in through SAML or OIDC federation are metered separately on every plan, Plus included: 50 free MAUs, then $0.015 per MAU. Every option also stores sessions in the block's DynamoDB table. A configuration whose only sign-in methods are `federateVia: 'direct'` providers creates no Cognito resources at all.

**How to choose.** Start with email + password: it is the default, needs no identity-provider account, runs fully offline, and is the only option where `Auth` itself enforces MFA and passkeys. Add `socialProviders` for consumer sign-in — those users cost the same as password users, but their sign-in only works on a deployed stack. For a workforce IdP or any other OIDC provider, keep the default `federateVia: 'direct'`: there is no Cognito charge, `stubIdp()` lets you test offline, and public PKCE-only clients work. Switch a provider to `federateVia: 'cognito'` only when you need its users in your user pool — Cognito groups, `auth.admin` or Cognito-issued tokens for them — and accept the 50-free-MAU meter and the client-secret requirement; it adds no MFA, device tracking or adaptive authentication, because Cognito leaves all authentication of federated users to their IdP. Use `samlProviders` only for an IdP that does not speak OIDC.

All five in one block (provider secrets are `AppSetting` references, never strings):

```typescript
import { AppSetting, Auth, Scope } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });
const entraSecret = new AppSetting(scope, 'entra-secret', { secret: true });

const auth = new Auth(scope, 'auth', {
  // Email + password is on unless you set `emailPassword: false`.
  socialProviders: { google: { clientId: 'your-google-client-id', clientSecret: googleSecret } },
  oidcProviders: {
    // Direct (the default): your backend verifies the IdP's tokens. No client secret needed.
    okta: { issuer: 'https://dev-12345.okta.com', clientId: '0oa-your-client-id' },
    // Through Cognito: the user lands in your user pool. A client secret is required.
    entra: {
      federateVia: 'cognito',
      issuer: 'https://login.microsoftonline.com/your-tenant-id/v2.0',
      clientId: 'your-entra-client-id',
      clientSecret: entraSecret,
    },
  },
  samlProviders: { corp: { metadataUrl: 'https://idp.example.com/saml/metadata' } },
});
```

## What it does

- The compiler rejects calls your configuration does not support (see [Mode gates](#mode-gates)).
- The session layer, the guards (`requireAuth`, `requireRole`, `checkAuth`, `getCurrentUser`, `getAuthSession`, `signOut`) and the `createApi()` state machine work the same for every sign-in method, and existing `AuthCognito` sessions are accepted.
- **Locally** (`npm run dev`, tests), email + password works end to end with no AWS account: sign-up with an emailed code, sign-in and its challenges, password reset, MFA (TOTP / SMS / email), devices, user attributes, `deleteUser`, passkeys, and the opt-in `auth.admin` surface. The local user pool lives in `.bb-data/<fullId>/state.json` — the same file `AuthCognito`'s mock writes, so local users survive the switch.
- On AWS, email + password runs against Amazon Cognito: sign-up and confirmation (with automatic sign-in after the emailed code), sign-in with every challenge `AuthCognito` supports (MFA, new-password-required, `USER_AUTH` choice-based and passwordless sign-in, passkey sign-in), password reset and change, token refresh, live group reads for `requireRole`, global sign-out and passkey management, user attributes, `deleteUser`, authenticator-app (TOTP) setup and MFA preferences, devices, and the opt-in `auth.admin` surface. `rememberDevice` throws a `501` on AWS, as it did in `AuthCognito` ([why](./DESIGN.md#known-gaps-documented-not-built)).
- Directly federated sign-in works, locally and deployed: any `oidcProviders` entry (OIDC discovery, PKCE, JWKS-verified ID tokens; public PKCE-only clients included), bare OAuth 2.0 through `github()` / `customOauth2()`, and the local stub IdP (`stubIdp()`), which gives `emailPassword: false` apps an offline sign-in.
- On AWS, social, SAML and `federateVia: 'cognito'` providers sign in through Cognito managed login: the sign-in button goes straight to the provider (PKCE, Cognito-issued tokens verified against your user pool), and the user becomes an ordinary user-pool user — `requireRole()` reads their Cognito groups and `auth.admin` manages them like email + password users. Sign-out also ends the managed-login session, so the next sign-in asks the provider again. MFA for these users is the provider's: Cognito never challenges a federated user, so enforce MFA at your IdP. Locally (`npm run dev`) these providers answer sign-in with an actionable `501` — managed login needs a deployed user pool; use a direct provider or `stubIdp()` for offline sign-in.
- Native and CLI clients can authenticate with `Authorization: Bearer <access token>` when `allowBearerAuth: true`, as with `AuthOIDC`: the guards accept a directly federated provider's access token (the one `/aws-blocks/auth/exchange` returns and `/aws-blocks/auth/exchange/refresh` renews) or a user-pool user's Cognito access token. The session cookie wins when both are sent, and a bearer token stays valid after `signOut()` until it expires. See [DESIGN.md](./DESIGN.md#bearer-tokens-allowbearerauth-d6c--bearerts).
- The CDK layer provisions the same resources as `AuthCognito` (same construct ids, so an `AuthCognito` app that switches keeps its user pool and sessions), creates no Cognito resources for a direct-OIDC-only configuration, and follows the stack's `removalPolicy` / `deletionProtection` defaults. For social, SAML and `federateVia: 'cognito'` providers it also provisions a Cognito domain, a separate hosted-UI app client and one identity-provider registration per provider (provider secrets stay in SSM and never enter the template); see `DESIGN.md` → *Hosted-UI federation* and *The hosted-UI engine*.
- The CDK layer refuses user-pool changes Cognito cannot apply to an existing pool (sign-in attributes, username case sensitivity, required attributes, changing or removing a custom attribute): at synth, against a baseline file it writes to `aws-blocks/baselines/` (commit that file), and again at deploy, before the pool is updated. The synth check also refuses a change that would remove the pool — including renaming or deleting the `Auth` block, which would make CloudFormation delete the pool and every user in it ([details](./DESIGN.md#renaming-or-removing-an-auth-block)) — once a committed baseline records the pool. A block's first synth has nothing to compare against: if it records no pool, synth only warns. Moving from `AuthCognito`? Deploy the codemod's output unchanged first ([MIGRATION.md](./MIGRATION.md#before-every-deploy-the-checklist)). Re-baseline deliberately with `BLOCKS_AUTH_REBASELINE=<block fullId>`. See [DESIGN.md](./DESIGN.md#immutability-guard-q5).

## Usage

You configure mechanisms as sibling keys of one options object. Providers are keyed records, and the record key is the provider id on both the server and the client:

- `new Auth(scope, 'auth')` — email + password, the zero-config default.
- `new Auth(scope, 'auth', { oidcProviders: { okta: { issuer, clientId } } })` — email + password plus Okta, federated directly by your backend.
- `new Auth(scope, 'auth', { emailPassword: false, oidcProviders: { okta: { issuer, clientId } } })` — Okta only. No Cognito user pool is created.
- `new Auth(scope, 'auth', { socialProviders: { google: { clientId, clientSecret } } })` — Google, federated through Cognito.

For local development without an identity provider account, use the stub IdP — a real OIDC provider served by the dev server, with an account picker:

```typescript
import { Auth, stubIdp } from '@aws-blocks/bb-auth';

const auth = new Auth(scope, 'auth', {
  emailPassword: false,
  oidcProviders: {
    corp: stubIdp({
      users: [
        { sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } },
        { sub: 'u-2', email: 'bob@example.com', name: 'Bob' },
      ],
    }),
  },
  users: { groups: ['admin'] },
});
```

The stub runs only in `npm run dev` by default; replace it with the real provider before deploying. Synthesizing a stack with a `stubIdp()` provider fails with "`stubIdp()` is local-only", so a backend module that is also deployed must choose its provider by environment — and the deployed Lambda must see the same choice synth did.

**Deploying the stub (test stacks only).** An end-to-end test stack that needs a sign-in with no external IdP can serve the stub from the deployed backend with `stubIdp({ users, unsafeAllowDeployed: true })`. This is unsafe for production: the deployed stub signs users in without credentials, so **anyone who can reach the app can sign in as any of the stub's users**, with their claims and groups. Synth succeeds with a `@aws-blocks/bb-auth:StubIdpDeployed` warning. Deployed, the stub's issuer is the API Gateway URL (`https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/aws-blocks/auth/idp/<id>`) and its signing keys are derived from the block's session secret, so every Lambda instance serves the same keys. Remove the flag, or swap in the real provider, before anything real is deployed.

A directly federated user's `userId` is `` `${issuer}:${sub}` `` (the same as `AuthOIDC`), and `requireRole()` reads their groups from the provider's `groupsClaim`. Register `<your origin>/aws-blocks/auth/callback` as the redirect URI with the IdP, and `<your origin>/` (or `<your origin><redirects.postSignOutPath>`) as the post-logout redirect URI when the IdP supports sign-out.

For a provider federated through Cognito (social, SAML, `federateVia: 'cognito'`) the CDK layer registers the callback and sign-out URLs on the Cognito app client for you; in the IdP's console, register the Cognito domain's `https://<domain>/oauth2/idpresponse` (`/saml2/idpresponse` for SAML) instead.

Provider secrets are `AppSetting` references created with `secret: true` (at the default name, with an explicit `name`, or via `AppSetting.fromExisting`), never strings. The RPC surface stays the two methods the sign-in UI uses (`getAuthState` / `setAuthState`), via `auth.createApi()`.

The option groups and the method surface are documented in the JSDoc of the exported `AuthOptions` and `AuthShape` types.

## Sign-up and email delivery

Every self-service sign-up confirms the email address with an emailed code. With `emailPassword.autoSignIn` (on by default), the user is then signed in without typing their password again — the code itself is still required.

Cognito's default email sender is limited to 50 emails per day (confirmation, password-reset and email-MFA codes all count). That is enough for development, not for production. `AuthOptions` does not configure Amazon SES yet; to send at volume today, configure SES on a pool you manage and wrap it with `userPool: Auth.fromExisting(userPoolId, clientId)`.

## One sign-up and sign-in policy: `validateUser`

`validateUser` is called before any user is created and before any session is issued, whatever the mechanism. Throw to reject; a thrown `ApiError` reaches the client by its `name` and message.

```typescript
import { ApiError } from '@aws-blocks/core';
import { Auth, AuthErrors } from '@aws-blocks/bb-auth';

const auth = new Auth(scope, 'auth', {
  validateUser: async ({ email }) => {
    if (!email?.endsWith('@example.com')) {
      throw new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
    }
  },
});
```

- `phase: 'signUp'` runs before a user-pool user is created: in `auth.signUp()` and `auth.admin.createUser()`, in your request. On AWS, setting the option also attaches a Cognito **PreSignUp trigger** to the pool (only then), which runs the same callback in your backend Lambda for users the app did not create itself: a `SignUp` sent straight to Cognito with the app client id, an `AdminCreateUser` from the console or CLI, and the first sign-in of a social, SAML or `federateVia: 'cognito'` user. A sign-up made through `auth.signUp()` is checked once, not twice. The trigger never confirms or verifies a user.
- `phase: 'signIn'` runs on every sign-in, so a federated user's first sign-in sees both phases. Directly federated providers (including `stubIdp()`) create no pool user and only see `signIn`.
- Keep it fast: Cognito waits at most 5 seconds for the trigger, and a cold start of your Lambda counts. If it does not answer in time the sign-up fails (no user is created). Avoid slow network calls in `validateUser` (cache any allowlist you fetch); if cold starts alone come close to the limit, configure provisioned concurrency on the backend Lambda.
- A pool you wrap with `userPool: Auth.fromExisting(...)` gets no trigger (its triggers are yours to manage); synth warns, and the in-process checks still run. Wrapping a pool another `Auth` in the same app creates (e.g. a second block for `admin`) is fine: the trigger stays with the block that created the pool and keeps running its `validateUser`. Details: [DESIGN.md](./DESIGN.md#validateuser-and-the-presignup-trigger-q10).

## Mode gates

The compiler knows which methods a configuration supports:

- With `emailPassword: false`, the email + password methods (`signUp`, `signIn`, `resetPassword`, …) are compile errors, and the error names the cause: `ERROR_emailPassword_is_disabled_on_this_Auth_instance`.
- With no federated provider configured, `getSignInUrl` is a compile error (`ERROR_no_federated_provider_is_configured`), and its `provider` argument only accepts configured provider ids.
- When the options set `mfa` to anything but `'optional'` / `'required'` (or omit it), the MFA methods (`setUpTotp`, `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`) are compile errors (`ERROR_mfa_is_off_on_this_Auth_instance`); when they configure no `passkeys` options object, so are the passkey methods (`ERROR_passkeys_are_not_enabled_on_this_Auth_instance`).
- `auth.admin` is unusable unless the options include `admin: {}`; with `admin: { actions: ['groups'] }`, the lifecycle methods are compile errors (`ERROR_admin_action_not_granted`), and vice versa.
- A narrowly configured instance is still assignable to the plain `Auth` type, so helpers typed `(auth: Auth)` keep working. On the plain type, federation and `auth.admin` are closed (type such a helper with the instance's own type, `typeof auth`), while the email + password, MFA and passkey methods stay callable and are checked at runtime. That includes `new Auth(scope, 'auth')` with no options, which the compiler cannot tell apart from the plain type.

Pass options inline (or with `satisfies AuthOptions`) rather than through a variable annotated `: AuthOptions`, or the compiler cannot see your configuration.

An option `Auth` does not recognise is an error at construction, in `npm run dev`, at synth and in Lambda alike, so a misspelled or misplaced setting can't be silently ignored. The error names each unknown option's path with a suggestion (`` `preferredChallenge`: it is not an option here; did you mean `users.preferredChallenge`? ``). The compiler alone doesn't catch these: TypeScript does no excess-property check on the inferred options type ([why](./DESIGN.md#unknown-options-d1b)). A boolean option must be `true` or `false` (or left out): a value such as `selfSignUp: 0` or `passkeys: 'false'` from untyped code is an error too, rather than turning the setting on or off by accident.

## Local development

Locally, no email or SMS is sent. Every verification code (sign-up, password reset, MFA, attribute verification) is written to `.bb-data/<fullId>/last-code.json` as `{ username, code, purpose }`, and is passed to the optional, local-only `codeDelivery` hook:

```typescript
const auth = new Auth(scope, 'auth', {
  codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
});
```

The AWS runtime ignores `codeDelivery`: Cognito delivers the codes. ⚠️ Local passwords are stored in plain text in `.bb-data/` (git-ignored) — never point the local runtime at real credentials. The local pool also accepts any 6-digit authenticator-app code and does not verify passkey signatures; see the mock-vs-AWS table in [DESIGN.md](./DESIGN.md#mock-vs-aws-behaviour-differences).

## Sign-in UI

`@aws-blocks/bb-auth/ui` re-exports the shared sign-in UI from `@aws-blocks/auth-common/ui` (`Authenticator`, `AccountMenuBar`, `AuthenticatedContent`, `onAuthChange`, `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`) and adds `authOverrides()`, which type-checks `Authenticator` options against `Auth`'s action, next-step and field names. Federated providers appear as `signIn:<id>` actions that carry a `url`, so the `Authenticator` renders them as plain "Sign in with …" buttons and the RPC surface stays `getAuthState` / `setAuthState`.

```typescript
import { Authenticator, authOverrides } from '@aws-blocks/bb-auth/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi, authOverrides({
  hideActions: ['signUp'],
  actions: { signIn: { fields: { username: { label: 'Email', autocomplete: 'email' } } } },
})));
```

To restyle, replace or drive the forms yourself, and for the `data-testid` contract e2e suites rely on, see [Customizing Auth UI](./CUSTOMIZING-AUTH-UI.md).

## Migrating from `AuthBasic`, `AuthCognito` or `AuthOIDC`

See [MIGRATION.md](./MIGRATION.md): per-block before → after code, what happens to deployed pools, users and sessions, and the codemod (`npx @aws-blocks/bb-auth migrate --dry-run`). The one rule: never change the block's id argument.

## Design

See [DESIGN.md](./DESIGN.md).
