# Auth

`Auth` is the single authentication Building Block for AWS CDK Blocks: one import and one options object for email + password, social sign-in, generic OIDC and SAML.

Import it from `aws-cdk-blocks` (or `@aws-cdk-blocks/bb-auth`), and its UI helpers from `aws-cdk-blocks/ui` (or `@aws-cdk-blocks/bb-auth/ui`).

> **First choice: where do your users live?** In a Cognito user pool (the default), or at their identity provider with `store: 'builtin'`. See [Where do your users live?](#where-do-your-users-live).

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

`new Auth(scope, 'auth')` is email + password sign-in on a Cognito user pool. Export `auth.createApi()` for the sign-in UI, and guard each API method:

```typescript
// cdk-blocks/index.ts
import { ApiNamespace, Auth, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth');
export const authApi = auth.createApi(); // the sign-in API the UI components call

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async whoAmI() {
    const user = await auth.requireAuth(context); // 401 NotAuthenticatedException when signed out
    return user.username;
  },
}));
```

`new Auth` provisions the backend, and `authApi` exposes the sign-in API. Neither renders a login screen. Mount the UI in the SPA entrypoint and gate the app shell behind a session:

The example mounts into `<div id="menu-bar"></div>` and `<div id="app"></div>`. The default template includes both; add either missing element to your page before running the snippet.

```typescript
// src/index.ts
import { api, authApi } from 'cdk-blocks';
import { AccountMenuBar, AuthenticatedContent } from 'aws-cdk-blocks/ui';

// A Sign In / account control that opens the Authenticator (sign-up, sign-in,
// the emailed code, password reset) when clicked.
document.getElementById('menu-bar')!.appendChild(AccountMenuBar(authApi));

// Gate the app shell: the render callback runs only while a session exists;
// the fallback shows while signed out.
const signInMessage = document.createElement('p');
signInMessage.textContent = 'Sign in to get started.';

document.getElementById('app')!.appendChild(
  AuthenticatedContent(authApi, (user) => {
    const el = document.createElement('div');
    el.textContent = `Welcome, ${user.displayName ?? user.username}`;
    // ...build the authenticated app here, calling your `api` methods...
    return el;
  }, signInMessage),
);
```

- An API method is public until it awaits a guard (`requireAuth`, `requireRole`). To guard every method of a namespace, use `auth.protect` ([Protect every method](#protect-every-method)).
- To embed the form inline instead, use `Authenticator(authApi)`. The components are documented in the [`auth-common` README](../auth-common/README.md).
- Sign-up asks for an emailed code. Locally no email is sent ([Local development](#local-development)).

## Which option and why

### Where do your users live?

Choose this first, once per block, with `store`. It decides which sign-in methods the block can offer:

- **`store: 'cognito'`** (the default, so usually omitted): users are records in an Amazon Cognito user pool. Email + password, MFA, passkeys, social sign-in, SAML and OIDC federated through Cognito. Cognito groups, `auth.admin` and Cognito-issued tokens work for every user.
- **`store: 'builtin'`**: no user pool. Users live at their identity provider, your backend verifies each sign-in itself, and the block keeps only its sessions. No Cognito charge, offline sign-in with `stubIdp()`, and public (PKCE-only) clients.

| | `store: 'cognito'` (default) | `store: 'builtin'` |
|---|---|---|
| Email + password, `mfa`, `passkeys`, `email` (SES sender), `codeDelivery` | Yes | No |
| `providers` entry `type: 'google' \| 'facebook' \| 'amazon' \| 'apple'` | Yes, keyed by its type (one per type) | No |
| `type: 'saml'` | Yes | No |
| `type: 'oidc'` | Yes, federated through Cognito; `clientSecret` required | Yes, verified by your backend; `clientSecret` optional, `groupsClaim` for roles |
| `type: 'oauth2'` (`github()`, `customOauth2()`) and `type: 'stub'` (`stubIdp()`) | No | Yes |
| `users` | The full user-pool shape (`signInWith`, `attributes`, `groups`, …) | `users.groups` only |
| `userPool` (wrap an existing pool), `admin`, `hostedUi`, `featurePlan` | Yes | No |
| `allowBearerAuth` | `true` (Cognito access tokens) or `{ clientIds }` (other app clients of the pool) | `true` (the provider's access token) |
| `validateUser` | Sign-up and sign-in | Sign-in only (no user is ever created) |
| `session`, `redirects`, `onSignIn` / `onSignOut`, `removalPolicy`, `deletionProtection` | Yes | Yes |
| What is provisioned | A user pool (or the one you wrap), plus a Cognito domain, a hosted-UI app client and one identity-provider registration per provider once a `providers` entry needs them; the session table and secret | The session table and secret only |

Choose the store before the first deploy. Switching a deployed block from the default store to `store: 'builtin'` removes its user pool and every user in it; the immutability guard refuses that at synth once a committed baseline records the pool ([DESIGN.md](./DESIGN.md#renaming-or-removing-an-auth-block)).

Every sign-in provider goes in one `providers` map, keyed by the provider id you use on the client (`getSignInUrl(context, '<id>')`, the `signIn:<id>` UI action), and tagged with its `type`.

**One block holds one kind of user.** A block cannot mix email + password users with backend-verified OIDC users. An app that wants both uses two `Auth` blocks, each with its own session cookie and its own `createApi()`, and the frontend picks one per sign-in. There is no account linking: the same person signing in through both blocks is two users.

```typescript
// cdk-blocks/index.ts
import { Auth, Scope, getDeploymentType, stubIdp } from 'aws-cdk-blocks';

const scope = new Scope('my-app');

// Customers: email + password, in the Cognito user pool.
const auth = new Auth(scope, 'auth');
export const authApi = auth.createApi();

// Staff: Okta, verified by the backend; the stub IdP outside production.
const sso = new Auth(scope, 'sso', {
  store: 'builtin',
  providers: {
    okta:
      getDeploymentType() === 'production'
        ? { type: 'oidc', issuer: 'https://dev-12345.okta.com', clientId: '0oa-your-client-id', groupsClaim: 'groups' }
        : stubIdp({ users: [{ sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['staff'] } }] }),
  },
  users: { groups: ['staff'] },
});
export const ssoApi = sso.createApi();
```

Two blocks that both have `providers` (say Google on the default store and Okta on `store: 'builtin'`) need their own `redirects.callbackPath` and `redirects.signOutPath`:

- With the defaults, both would mount `/cdk-blocks/auth/callback` and `/cdk-blocks/auth/signout`. Synth fails on the second block, naming both, and `npm run dev` refuses it when the backend loads.
- A block without `providers` mounts no sign-in routes. That is why `sso` above keeps the default `redirects` next to the password-only `auth`.
- Two `stubIdp()` providers in two blocks need different provider keys: a stub IdP's routes are keyed by its provider key alone, whatever the `redirects`.
- Register each block's callback URL with its provider. The example at the end of [The sign-in methods](#the-sign-in-methods) gives `sso` its own paths.

### The sign-in methods

| Option | Configure with | What it's for | Cognito pricing | Works offline in `npm run dev` | Cognito groups / `auth.admin` | MFA | PKCE-only IdPs |
|---|---|---|---|---|---|---|---|
| **Email + password** | `emailPassword` (on by default; default store) | Your own user directory: sign-up with an emailed code, password reset, passkeys | 10,000 free MAUs (none on `'plus'`), then the user pool's feature-plan rate | Yes: a local user pool in `.cdk-blocks/local/data/` | Yes | Yes: Cognito MFA through `mfa` (TOTP or SMS; email MFA once `email` sends through SES) | Not applicable |
| **Social** | `providers` entry with `type: 'google'`, `'apple'`, `'facebook'` or `'amazon'` (default store) | Consumer "Sign in with Google / Apple / Facebook / Amazon" | Same free tier and rate as email + password | No: sign-in answers an actionable `501` locally; deploy a sandbox to test it | Yes: the user becomes a user-pool user | Handled by the provider; Cognito never challenges a federated user | Not applicable |
| **Generic OIDC, verified by your backend** | `store: 'builtin'` with `type: 'oidc'` entries (plus `github()`, `customOauth2()`, `stubIdp()`) | Okta, Entra ID, Auth0, GitHub or any other OIDC / OAuth 2.0 provider, verified by your own backend | No Cognito charge: these users never touch Cognito | Yes: with `stubIdp()`, a real OIDC provider served by the dev server | No pool record: `requireRole()` reads groups from the provider's `groupsClaim`; `auth.admin` does not apply | The provider's | Yes: omit `clientSecret` |
| **Generic OIDC, through Cognito** | `type: 'oidc'` entry on the default store | The same providers, when you need their users in your Cognito user pool | Separate federated meter: 50 free MAUs, then $0.015 per MAU on every feature plan | No: `501` locally, like social | Yes: the user becomes a user-pool user | Handled by the provider; Cognito never challenges a federated user | No: Cognito requires a client secret |
| **SAML** | `type: 'saml'` entry (default store) | Enterprise IdPs that only speak SAML 2.0 | Same separate meter as OIDC through Cognito: 50 free MAUs, then $0.015 per MAU | No: `501` locally, like social | Yes: the user becomes a user-pool user | Handled by the provider; Cognito never challenges a federated user | Not applicable (SAML has no PKCE) |

MAU = monthly active user. Prices are from [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) as read on 4 October 2026; check it before you ship. The feature-plan rate depends on `featurePlan`:

| `featurePlan` | Rate per MAU | Free tier | Cannot run |
|---|---|---|---|
| `'essentials'` (the default) | $0.015 | 10,000 MAUs | None |
| `'lite'` | $0.0055 | 10,000 MAUs | Passkeys, passwordless sign-in, email MFA |
| `'plus'` | $0.020 | None | None |

Every option also stores sessions in the block's DynamoDB table.

**How to choose.**

- Start with email + password: it is the default, needs no identity-provider account, runs fully offline, and is the only option where `Auth` itself enforces MFA and passkeys.
- For consumer sign-in, add social `providers` entries. Those users cost the same as password users, but their sign-in only works on a deployed stack.
- For a workforce IdP or any other OIDC provider, prefer a `store: 'builtin'` block: there is no Cognito charge, `stubIdp()` lets you test offline, and public PKCE-only clients work.
- Put a `type: 'oidc'` entry on the default store only when you need its users in your user pool: next to password users, or for Cognito groups, `auth.admin` or Cognito-issued tokens. You accept the 50-free-MAU meter and the client-secret requirement, and it adds no MFA, device tracking or adaptive authentication.
- Use `type: 'saml'` only for an IdP that does not speak OIDC.
- If a frontend may later sign in with the Amplify client libraries against the same pool, read [Planning to use Amplify client libraries?](#planning-to-use-amplify-client-libraries) before the first deploy: some of those choices are permanent.

This example configures all five sign-in methods in the two blocks they need. Both blocks have `providers`, so `sso` gets its own `redirects`: register `<origin>/cdk-blocks/auth/sso/callback` with Okta (`auth` keeps the default `/cdk-blocks/auth/callback`):

```typescript
import { AppSetting, Auth, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });
const entraSecret = new AppSetting(scope, 'entra-secret', { secret: true });

// The default store: every user is a user-pool user.
const auth = new Auth(scope, 'auth', {
  // Email + password is on unless you set `emailPassword: false`.
  providers: {
    google: { type: 'google', clientId: 'your-google-client-id', clientSecret: googleSecret },
    // OIDC through Cognito: the user lands in your user pool. A client secret is required.
    entra: {
      type: 'oidc',
      issuer: 'https://login.microsoftonline.com/your-tenant-id/v2.0',
      clientId: 'your-entra-client-id',
      clientSecret: entraSecret,
    },
    corp: { type: 'saml', metadataUrl: 'https://idp.example.com/saml/metadata' },
  },
});

// No user pool: your backend verifies Okta's tokens. No client secret needed.
const sso = new Auth(scope, 'sso', {
  store: 'builtin',
  providers: { okta: { type: 'oidc', issuer: 'https://dev-12345.okta.com', clientId: '0oa-your-client-id' } },
  // Its own sign-in routes: `auth` above already mounts the default ones.
  redirects: { callbackPath: '/cdk-blocks/auth/sso/callback', signOutPath: '/cdk-blocks/auth/sso/signout' },
});
```

## Recipes

### Protect every method

A method of `new ApiNamespace(...)` is public until it awaits a guard, so a forgotten guard, or one called without `await`, serves the data to anyone, and nothing warns you. Define the namespace with `auth.protect` instead. It takes two method factories: `methods`, which runs only after the session check and gets the signed-in user, and `public` (optional), for methods anyone may call.

```ts
// cdk-blocks/index.ts
import { Auth, KVStore, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  users: { groups: ['admin'] },
  admin: {},
});
const notes = new KVStore(scope, 'notes');
export const authApi = auth.createApi();

export const notesApi = auth.protect(scope, 'notesApi', {
  // Anyone can call these: no session check, no user.
  public: (context) => ({
    async health() {
      return { ok: true };
    },
  }),
  // Runs only after the session check, once per call, with the signed-in user —
  // typed by this block's options: no guard to write, no cast.
  methods: (context, user) => ({
    async addNote(text: string) {
      await notes.put(`${user.userSub}:${crypto.randomUUID()}`, text);
    },
    async myGroups() {
      return user.groups; // ('admin')[]
    },
  }),
});

// With `role`, every protected method also requires the group, as `requireRole` does.
export const adminApi = auth.protect(scope, 'adminApi', {
  methods: () => ({
    async listUsers() {
      return Array.fromAsync(auth.admin.scan(), (u) => u.username);
    },
  }),
}, { role: 'admin' });
```

The frontend calls every method, public and protected, like any other namespace:

```ts
// src/main.ts
import { isBlocksError } from 'aws-cdk-blocks/client';
import { notesApi } from 'cdk-blocks';

await notesApi.health(); // works signed out
try {
  await notesApi.addNote('hello');
} catch (e) {
  if (isBlocksError(e, 'NotAuthenticatedException')) {
    // signed out: show the sign-in UI
  }
}
```

- **A protected call** checks the session first, with `requireAuth(context)` (or `requireRole(context, role)`), so sessions, bearer tokens (`allowBearerAuth`) and live group reads work exactly as they do there, locally and on AWS. No valid session: 401 `NotAuthenticatedException`. With `role`, a signed-in user outside the group: 403 `NotAuthorizedException`.
- **An anonymous call to a name that isn't public** gets the same 401, whether or not the method exists, so a signed-out caller can't list your protected methods. A signed-in caller gets "method not found" for a name `methods` doesn't define.
- **A public method** runs exactly as in a plain `ApiNamespace`. It has no `user`; call `auth.getCurrentUser(context)` in it for an optional one.
- **A name can't be in both** `public` and `methods`: that is a compile error (and an error at runtime for untyped JavaScript).
- The `ApiNamespace` options, such as `compute`, go in the last argument, next to `role`. You can still call `requireRole` inside a protected method for a stricter check on one method.

A lint rule does not replace `protect`. Biome's `noFloatingPromises` does not flag an un-awaited `auth.requireAuth(context)` or `auth.requireRole(context, …)`. typescript-eslint's type-aware `no-floating-promises` does, but only where you have set it up.

### MFA with an authenticator app (TOTP)

Turn MFA on. The sign-in state machine (`authApi = auth.createApi()`) then also enrols an authenticator app for a signed-in user, so there is no backend code to write:

```ts
// cdk-blocks/index.ts
import { Auth, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  // totpIssuer: the name authenticator apps show next to the codes (default: the root Scope id, 'my-app').
  mfa: { mode: 'optional', types: ['TOTP'], totpIssuer: 'My App' },
});
export const authApi = auth.createApi();
```

The `Authenticator` asks for the 6-digit code at sign-in once a user is enrolled. With `mode: 'required'` it also walks a user with no factor through TOTP setup mid-sign-in.

`MfaSettings` is the enrolment panel for your account page: it shows the setup key, an `otpauth://` link and, if you pass `renderQrCode`, a QR code from the library of your choice, then asks for the code from the app. Once enrolled, the user can make the authenticator app the default or turn it off ([details](./CUSTOMIZING-AUTH-UI.md#mfa-settings)):

```ts
// src/main.ts
import { Authenticator, MfaSettings } from 'aws-cdk-blocks/ui';
import { authApi } from 'cdk-blocks';

document.body.appendChild(Authenticator(authApi));

// On the account settings page (it renders nothing while signed out):
document.body.appendChild(MfaSettings(authApi));
```

A custom UI submits the same actions. Each returns an `AuthState`:

- `setUpTotp` returns a `verifyTotpSetup` action that carries the `sharedSecret` and the `otpauthUri` (the QR code's content) as hidden fields.
- The other actions return the settings, with one `updateMfaPreference` action per change the user can make.
- A wrong code comes back `retriable`.
- A signed-out caller gets the `NotAuthenticatedException` state.
- Replacing an enrolled authenticator (`setUpTotp` again) and turning a factor off (`'DISABLED'`) need a sign-in within `session.freshAgeSeconds` (default 15 minutes). Otherwise they answer the `ReauthenticationRequiredException` state with the sign-in form, so a stolen session cookie cannot swap the authenticator or turn MFA off.
- An abandoned replacement leaves the current authenticator working.

```ts
// src/account.ts
import { authApi } from 'cdk-blocks';

const setup = await authApi.setAuthState({ action: 'setUpTotp' });
const verify = setup.actions.find((a) => a.name === 'verifyTotpSetup');
const otpauthUri = verify?.fields.find((f) => f.name === 'otpauthUri')?.defaultValue; // render it as a QR code

const done = await authApi.setAuthState({ action: 'verifyTotpSetup', code: '123456' }); // the code the user typed
if (done.retriable) console.log(done.error); // a wrong code: ask again
await authApi.setAuthState({ action: 'updateMfaPreference', totp: 'PREFERRED' });
console.log(otpauthUri);
```

With MFA off, these actions are compile errors, in the frontend too, and `updateMfaPreference` takes only the factors in `mfa.types` ([Mode gates](#mode-gates)). The server-side methods (`auth.setUpTotp(context)`, `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`) do the same for your own API methods.

Locally the user pool accepts any 6-digit code unless you opt in to real verification with `totpVerification: 'rfc6238'`; deployed, Cognito always verifies it (see [Local development](#local-development)).

**`mfa` and Cognito's threat protection.** `mfa` adds a second factor; it does not detect stolen passwords. Cognito's compromised-credential detection and adaptive authentication belong to the `'plus'` feature plan. The default, `featurePlan: 'essentials'`, does not include them, and this block does not turn them on for you: set `featurePlan: 'plus'` (see [the sign-in methods](#the-sign-in-methods) for the price) and configure threat protection on the user pool yourself if you need them.

### Session lifetime and refresh tokens

A signed-in user holds a session row in the block's table and the Cognito tokens inside it. The `session` options set how long each lives:

```ts
// cdk-blocks/index.ts
import { Auth, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  session: {
    ttlSeconds: 30 * 86_400,
    refreshTokenValiditySeconds: 30 * 86_400,
    accessTokenValiditySeconds: 3_600,
    idTokenValiditySeconds: 3_600,
    refreshTokenRotation: true,
  },
});
export const authApi = auth.createApi();
```

| Option | Default | What it does |
|---|---|---|
| `ttlSeconds` | 30 days | How long a session may sit unused before its row and cookie expire. |
| `refreshTokenValiditySeconds` | `ttlSeconds` | When the Cognito refresh token ends the session, counted from sign-in. Neither a refresh nor rotation extends it, so the user signs in again after this long however active they were. Whole minutes, 3600 to 315,360,000. |
| `accessTokenValiditySeconds`, `idTokenValiditySeconds` | 1 hour | How long a token works before the block refreshes it. Whole minutes, 300 to 86,400, and not above the refresh token's lifetime. |
| `refreshTokenRotation` | `true` | Cognito issues a new refresh token on each refresh and revokes the old one, after a 10-second grace period that lets a concurrent request retry. |
| `freshAgeSeconds` | 15 minutes (`900`) | How recently the user must have signed in for `requireAuth(context, { fresh: true })`, and to replace or turn off an MFA factor. An older sign-in answers 401 `ReauthenticationRequiredException`. |
| `crossDomain` | `false` | Set `true` only when the frontend and the API are on different registrable domains. The cookie becomes `SameSite=None; Secure; Partitioned`. |

The two limits work together: the session ends at the earlier of `ttlSeconds` without use and `refreshTokenValiditySeconds` since sign-in. Both app clients (`client` and the hosted-UI client) get the same settings. Changing them updates the clients in place; it does not replace a client or sign anyone out. Tokens already issued keep the lifetime they were issued with.

**Rotation and other clients.** Cognito does not allow the `REFRESH_TOKEN_AUTH` flow on a client with rotation on, so the block removes `ALLOW_REFRESH_TOKEN_AUTH` from its clients and refreshes with `GetTokensFromRefreshToken`. If another app refreshes against the same client with `REFRESH_TOKEN_AUTH`, move it to `GetTokensFromRefreshToken` or set `refreshTokenRotation: false`. With `userPool`, configure token lifetimes and rotation on your existing app client; the block refuses those four options. `ttlSeconds`, `freshAgeSeconds` and `crossDomain` still apply to the block's own sessions.

### Roles and an admin-only user list

Declare the groups, opt in to `auth.admin`, and gate the method with `requireRole`:

```ts
// cdk-blocks/index.ts
import { ApiNamespace, Auth, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  users: { groups: ['admin'] }, // the groups requireRole and auth.admin accept; a typo is a compile error
  admin: {}, // opt in to auth.admin (and its IAM grant)
});
export const authApi = auth.createApi();

export const adminApi = new ApiNamespace(scope, 'adminApi', (context) => ({
  async listUsers() {
    await auth.requireRole(context, 'admin'); // 401 signed out, 403 not in the group
    return Array.fromAsync(auth.admin.scan(), (u) => ({ username: u.username, email: u.attributes.email ?? null }));
  },
}));
```

`requireRole` reads the user's groups live from the user pool, so a group change applies at the user's next request, not at their next sign-in. To require the group on every method of a namespace, use `auth.protect(scope, 'adminApi', { methods }, { role: 'admin' })` instead ([Protect every method](#protect-every-method)).

`auth.admin` checks only that the block opted in and that the action was granted, never who is calling, so every method that calls it must authorize its caller first, as `listUsers` does above. The handle itself is never an API: exporting `auth.admin`, returning it from an `ApiNamespace` handler, or copying its methods into your own object (`{ ...auth.admin }`, `Object.assign({}, auth.admin)`, `{ remove: auth.admin.deleteUser }`) answers *method not found*.

**Authorizing on a custom attribute instead of a group.** End users write their own attributes at sign-up, through `updateUserAttributes` and in the new-password step of `confirmSignIn`. For a role, tenant id, plan tier or similar:

- Declare the attribute with `userWritable: false`. `Auth` then refuses an end-user write of it with `NotAuthorizedException`, locally too. The app clients the block creates leave it out of their write attributes, so Cognito refuses it as well.
- Set it server-side: `auth.admin.createUser(username, { attributes })` for a new user, `auth.admin.updateUserAttributes(username, { role: 'admin' })` for one who already exists. Both are under the `lifecycle` admin action, which grants `cognito-idp:AdminUpdateUserAttributes`. Call them from a method that authorizes its caller.
- Add `mutable: false` when the value must never change after creation.
- `userWritable: false` can't be combined with `required: true`.
- No provider's `attributeMapping` may map onto the attribute: the provider's claim would overwrite the value on every federated sign-in.

```typescript
users: {
  attributes: [
    { name: 'department' },                                  // end users may set it
    { name: 'role', userWritable: false },                   // admin-only
    { name: 'tenantId', userWritable: false, mutable: false }, // admin-only, set once
  ],
},
```

### The first admin

`requireRole(context, 'admin')` needs someone in `admin` already. Make the first one with the `users` command, once: sign up as yourself, then add your account to the group. It works the same on the local pool and on a deployed one:

```sh
# Local pool (.cdk-blocks/local/data/): stop the dev server first (npm run dev:stop), start it again afterwards.
npx @aws-cdk-blocks/bb-auth users add-to-group you@example.com admin

# The pool a deployed stage owns, with your AWS credentials (--profile / --region, or AWS_PROFILE / AWS_REGION).
# Without --yes it checks the stack, the user and the group, prints what it would do, and changes nothing.
npx @aws-cdk-blocks/bb-auth users add-to-group you@example.com admin --stage prod --yes
```

- `<user>` is the username, or the user's **verified** email or phone number. An unverified one is refused. So is a value that is one user's username and another user's verified email. Name the account outright with `--username <name>` or `--email <address>` (verified only) in place of `<user>`.
- The group must be one the block declares in `users.groups`; the command refuses any other, and a user the pool does not have. On a deployed stage the groups are read from the stack. Locally they are the groups the local pool holds, which keeps a group dropped from `users.groups` until `.cdk-blocks/local/data/` is reset.
- On a deployed stage the command first prints the pool with the AWS account and Region your credentials point at, so a wrong `--profile` shows before you add `--yes`.
- `--stage sandbox` is this checkout's sandbox and `--stage prod` the production stack (the names `npm run sandbox` and `npm run deploy` give them); `--stack <name>` names any other stack.
- A block with `userPool: Auth.fromExisting(…)` is refused: manage that pool's groups where it is managed.
- With more than one `Auth` block, pick one with `--block <id>` (its id, or its full id when ids overlap, e.g. `auth` and `oidc-auth`).
- `remove-from-group <user> <group>` undoes it, and `list-groups [<user>]` lists the block's groups, or the groups a user is in. Every write to a deployed pool needs `--yes`. Run `npx @aws-cdk-blocks/bb-auth users --help` for the rest.

Once the first admin exists, have them manage groups through an admin-only method that calls `auth.admin.addUserToGroup` / `removeUserFromGroup` (the [Roles](#roles-and-an-admin-only-user-list) recipe).

**Alternative: from `onSignIn`.** To make the first admin in code instead — for example when no one can run commands against the deployed stage — call `auth.admin.addUserToGroup` from `onSignIn` for an allowlisted email, and check that the pool has **verified** that address:

- `user.attributes.email` is not proof that the user owns the address: a signed-in user can change their own email (`updateUserAttributes`), and the new address applies at once, unverified.
- `user.attributes` does not carry `email_verified`. Read the pool's record with `auth.admin.getUser` (or, for the signed-in user, `getUserAttributes`) and require `email_verified === 'true'`. The same holds for `phone_number`.
- A federated user's email is the identity provider's claim, not a verification by this pool: leave federated users out, or trust only a provider whose claims you control.
- Users can't write `email_verified` / `phone_number_verified` (`NotAuthorizedException`, locally too): the app clients this block creates leave both out of their `WriteAttributes`. The exception is a flag that a provider's `attributeMapping` maps. Map `email_verified` only when self sign-up is off, or from a provider whose claim you would accept for any user.
- With `userPool: Auth.fromExisting(…)`, check that the pool's other app clients leave `email_verified` out of their `WriteAttributes` as well (Cognito's default, with no `WriteAttributes`, is every standard and custom attribute): a user who can write the flag can mark any address verified.

```ts
// cdk-blocks/index.ts
import { Auth, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const ADMIN_EMAILS = new Set(['you@example.com']);

const auth = new Auth(scope, 'auth', {
  users: { groups: ['admin'] },
  admin: {}, // the group methods, plus getUser to read email_verified
  onSignIn: async (user) => {
    if (user.signInProvider !== 'password') return; // a provider's email claim is not verified by this pool
    const record = await auth.admin.getUser(user.username);
    const email = record?.attributes.email?.toLowerCase();
    // Idempotent: an existing member stays a member.
    if (record?.attributes.email_verified === 'true' && email && ADMIN_EMAILS.has(email)) {
      await auth.admin.addUserToGroup(user.username, 'admin');
    }
  },
});
export const authApi = auth.createApi();
```

The hook works the same locally and deployed. Once the first admin exists, empty the allowlist: unlike the command, it stays in the code after it has done its job.

### Social sign-in: the client secret and the callback URL

A provider secret is a reference, never a string: a string-valued `Secret` (AWS Secrets Manager), or an `AppSetting` created with `secret: true` (an SSM SecureString). The CloudFormation template contains only the reference. When registering these providers, the deployment Lambda reads the value and passes it to Cognito. This app uses one of each:

```ts
// cdk-blocks/index.ts
import { AppSetting, Auth, Scope, Secret } from 'aws-cdk-blocks';

const scope = new Scope('my-app');

// A Secret, set with `npm run secret` (step 1).
const googleSecret = new Secret(scope, 'google-client-secret', {
  name: 'my-app/GOOGLE_CLIENT_SECRET',
  generate: true, // a placeholder value, so the first deploy can register the provider
});
// An SSM SecureString you create yourself.
const facebookSecret = AppSetting.fromExisting(scope, 'facebook-secret', {
  name: '/my-app/facebook-client-secret',
  secret: true,
});

const auth = new Auth(scope, 'auth', {
  providers: {
    // A social entry is keyed by its type.
    google: { type: 'google', clientId: 'your-client-id.apps.googleusercontent.com', clientSecret: googleSecret },
    facebook: { type: 'facebook', clientId: 'your-facebook-app-id', clientSecret: facebookSecret },
  },
  hostedUi: { domainPrefix: 'my-app-auth' }, // fixes the callback URL before the first deploy
});
export const authApi = auth.createApi();
```

1. **Set the secret values**, in the account and Region you deploy to. Each deploy re-registers the providers with the current values, so to rotate a secret, set the new value and deploy again.
   - **`Secret`:** deploy once (it creates `my-app/GOOGLE_CLIENT_SECRET` with the `generate: true` placeholder), run `npm run secret -- set GOOGLE_CLIENT_SECRET --prefix my-app`, then deploy again. The command prompts for the value; `--value-stdin` reads it from a pipe; add `--region <region>` if your shell's default Region differs.
     - Without `generate: true` the first deploy fails, because the secret has no value yet. Synth warns about it (`@aws-cdk-blocks/bb-auth:ProviderSecretWithoutValue`).
     - If that deploy already failed and the retained secret now makes the next one fail with "already exists": set its value with `npm run secret` and wrap it with `Secret.fromExisting('<secret ARN>')`, or delete it (`aws secretsmanager delete-secret --secret-id my-app/GOOGLE_CLIENT_SECRET --force-delete-without-recovery`) and deploy again with `generate: true`.
     - Without an explicit `name`, the secret is named after the block's `fullId`; set it with `aws secretsmanager put-secret-value` instead.
     - For a secret that already exists, wrap it: `new Secret(scope, 'google-client-secret', { secret: Secret.fromExisting('<secret ARN>') })`.
     - The deploy-time provider registration can read exactly this secret (`secretsmanager:GetSecretValue` on its ARN, plus `kms:Decrypt` via Secrets Manager). The app's execution role can read it too, like every `Secret` the app declares.
   - **`AppSetting`:** before the first deploy, use the Systems Manager Parameter Store console to create `/my-app/facebook-client-secret` as a `SecureString` with the provider's client secret. To rotate it, edit the parameter value and deploy again. With `new AppSetting(scope, 'facebook-secret', { secret: true })` instead, the deploy creates `/<fullId>` with a random value; replace it the same way.
2. **Register the callback URL** with the provider. Google calls it an *authorized redirect URI*: `https://my-app-auth.auth.<region>.amazoncognito.com/oauth2/idpresponse` (`/saml2/idpresponse` for SAML). Without `hostedUi.domainPrefix` the prefix is derived from the block's `fullId`; read it from the `UserPoolDomain` resource in the synthesized template. `hostedUi.domainPrefix` is create-only: choose it before the first deploy.
3. **Test on a sandbox** (`npm run sandbox`). Cognito managed login needs a deployed user pool, so under `npm run dev` these providers are unavailable:
   - `getAuthState()` marks the action `unavailable`, and the `Authenticator` shows the button disabled, with a hint.
   - The sign-in route answers `501`: an explanatory page for a browser, the `ProviderUnavailableException` JSON error for an API client.
   - For an offline federated sign-in flow, use `stubIdp()` in a `store: 'builtin'` block ([The stub IdP](#the-stub-idp-stubidp)).

### The stub IdP (`stubIdp()`)

For local development without an identity provider account, use the stub IdP. The dev server serves a real OIDC provider with an account picker:

```ts
// cdk-blocks/index.ts
import { Scope } from 'aws-cdk-blocks';
import { Auth, stubIdp } from '@aws-cdk-blocks/bb-auth';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  store: 'builtin',
  providers: {
    corp: stubIdp({
      users: [
        { sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } },
        { sub: 'u-2', email: 'bob@example.com', name: 'Bob' },
      ],
    }),
  },
  users: { groups: ['admin'] },
});
export const authApi = auth.createApi();
```

`stubIdp()`, `github()` and `customOauth2()` require `store: 'builtin'`. On the default store, TypeScript reports that the provider is not assignable to `CognitoProvider`. Set `store: 'builtin'` or put the provider in a separate block with that store.

The stub runs in `npm run dev` and on sandbox deployments (`npm run sandbox`) only. Synthesizing any other deployment with a `stubIdp()` provider fails, so a backend module that is also deployed to production must choose its provider by deployment type. `getDeploymentType()` reports the same value at synth and in the deployed Lambda (`'local'`, `'sandbox'` or `'production'`), so both make the same choice.

**The stub in local dev and sandbox, the real provider in production.** Keep one provider id and pick its entry from `getDeploymentType()`, as the two-block example in [Where do your users live?](#where-do-your-users-live) does. The client code (`signIn:<id>`) is then the same everywhere.

A `type: 'oidc'` entry of a `store: 'builtin'` block also works in `npm run dev`, without the stub, if you register `http://localhost:<port>/cdk-blocks/auth/callback` as a redirect URI with the provider.

**The stub on a sandbox.** A sandbox serves the stub from the deployed backend, so an end-to-end test needs no external IdP.

- The stub signs users in without credentials: **anyone who can reach the sandbox can sign in as any of the stub's users**, with their claims and groups.
- Synth succeeds with a `@aws-cdk-blocks/bb-auth:StubIdpDeployed` warning.
- A `cdk watch` hotswap alone does not turn the stub on: if the stub answers `501` on a sandbox, restart `npm run sandbox` once.
- The issuer and signing keys of a deployed stub are described in [DESIGN.md](./DESIGN.md).

**Redirect URIs to register with a provider.**

- `store: 'builtin'`: `<your origin>/cdk-blocks/auth/callback` as the redirect URI, and `<your origin>/` (or `<your origin><redirects.postSignOutPath>`) as the post-logout redirect URI when the IdP supports sign-out.
- Default store: the Cognito domain's URL ([step 2 of the social sign-in recipe](#social-sign-in-the-client-secret-and-the-callback-url)). The block registers its own callback and sign-out URLs on the Cognito app client.

A `store: 'builtin'` user's `userId` is `` `${issuer}:${sub}` ``, and `requireRole()` reads their groups from the provider's `groupsClaim`.

### End-to-end tests: emailed codes and two users at once

Against the local pool (`npm run dev`), a test reads the code a user was "sent" with `getLastAuthCode`, and acts as several users at once with `createTestClient`, which gives each user the app's typed clients with their own cookie jar. Both come from `aws-cdk-blocks/utils` (`getLastAuthCode` also from `@aws-cdk-blocks/bb-auth/testing`), are Node-only, and belong in test code:

```ts
// cdk-blocks/index.ts
import { ApiNamespace, Auth, KVStore, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const notes = new KVStore(scope, 'notes');
const auth = new Auth(scope, 'auth', { users: { signInWith: ['email'] } });
export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async saveNote(text: string) {
    const user = await auth.requireAuth(context);
    await notes.put(user.userSub, text);
  },
  async readNote() {
    const user = await auth.requireAuth(context);
    return notes.get(user.userSub);
  },
}));
```

```ts
// test/e2e.test.ts
import assert from 'node:assert';
import { test } from 'node:test';
import { createTestClient, getLastAuthCode } from 'aws-cdk-blocks/utils';

const app = await import('cdk-blocks');

/** A new user, signed up and signed in, with a session of their own. */
async function newUser(email: string) {
  const user = createTestClient(app);
  await user.authApi.setAuthState({ action: 'signUp', username: email, password: 'Passw0rd!' });
  const code = await getLastAuthCode(email);
  await user.authApi.setAuthState({ action: 'confirmSignUp', username: email, code });
  await user.authApi.setAuthState({ action: 'autoSignIn', username: email });
  return user;
}

test('each user reads only their own note', async () => {
  const owner = await newUser(`owner-${Date.now()}@example.com`);
  const other = await newUser(`other-${Date.now()}@example.com`);
  await owner.api.saveNote('mine');
  assert.strictEqual(await other.api.readNote(), null); // both signed in at once
  assert.strictEqual(await owner.api.readNote(), 'mine');
});
```

- `getLastAuthCode(username, { block?, purpose?, cwd? })` takes the name the user signs in with (their email on an email sign-in pool). It reads the codes the local pool still holds, so a user's code stays readable after another user's was sent. It throws when there is no such code, and when there is no local pool: against a deployed backend Cognito emails the code.
- Run the test from the directory the dev server runs in (the project root), under `tsx -C browser` so `import('cdk-blocks')` is the generated client, as the scaffolded `npm run test:e2e` does.
- `createTestClient(app)` returns the clients typed as passed. One user's clients share a jar, so a session `authApi` starts is sent by `api` too; the shared jar `installCookieJar()` installs is never involved.

### Tell the user what a password needs

Set the policy, and branch on the error the client receives:

```ts
// cdk-blocks/index.ts
import { Auth, Scope } from 'aws-cdk-blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  emailPassword: { passwordPolicy: { minLength: 12, requireSymbols: false } },
});
export const authApi = auth.createApi();
```

```ts
// src/main.ts
import { hasAuthError } from 'aws-cdk-blocks/client';
import { submitAuthAction } from 'aws-cdk-blocks/ui';
import { authApi } from 'cdk-blocks';

const next = await submitAuthAction(authApi, {
  action: 'signUp',
  username: 'alice',
  email: 'alice@example.com',
  password: 'short',
});
if (hasAuthError(next, 'InvalidPasswordException')) {
  // next.error says what a password needs; show it next to the password field.
}
```

For what the policy covers and what the message says, see [Password policy](#password-policy).

## Usage

`new Auth(scope, id, options?)`. Pick the block's `store` first ([Where do your users live?](#where-do-your-users-live)); every other setting is a key of the one options object:

- `new Auth(scope, 'auth')`: email + password, the zero-config default.
- `new Auth(scope, 'auth', { providers: { google: { type: 'google', clientId, clientSecret } } })`: email + password plus Google, federated through Cognito.
- `new Auth(scope, 'auth', { providers: { okta: { type: 'oidc', issuer, clientId, clientSecret } } })`: email + password plus Okta, federated through Cognito (a client secret is required).
- `new Auth(scope, 'auth', { store: 'builtin', providers: { okta: { type: 'oidc', issuer, clientId } } })`: Okta only, federated directly by your backend. No Cognito user pool is created. For password users as well, [add a second block](#where-do-your-users-live). For offline sign-in, see [the stub IdP recipe](#the-stub-idp-stubidp), including how to select the real provider for production.

The guards (`requireAuth`, `requireRole`, `checkAuth`, `getCurrentUser`, `getAuthSession`, `signOut`) and `createApi()` work the same for every sign-in method. Each method is documented on the exported `AuthShape` type: `npm run docs:api Auth`.

### Options

"Default store only" marks an option that is a compile error with `store: 'builtin'`. A dotted name is a key of that option's object.

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `'cognito' \| 'builtin'` | `'cognito'` | Where the users live ([Where do your users live?](#where-do-your-users-live)). |
| `emailPassword` | `boolean \| EmailPasswordOptions` | `true` | Email + password sign-in. `false` makes the password methods compile errors. Default store only. |
| `emailPassword.selfSignUp` | `boolean` | `true` | Users may register themselves. `false`: users are created only through `auth.admin`. |
| `emailPassword.passwordPolicy` | `PasswordPolicy` | 8 characters, all four character kinds | [Password policy](#password-policy). |
| `emailPassword.autoSignIn` | `boolean` | `true` | Sign the user in once they enter the emailed confirmation code ([Sign-up and email delivery](#sign-up-and-email-delivery)). |
| `emailPassword.revealExistingUsers` | `boolean` | `false` | Whether sign-up, confirmation and password reset reveal account state ([Sign-up and email delivery](#sign-up-and-email-delivery)). |
| `providers` | `Record<string, CognitoProvider>`; with `store: 'builtin'`, `Record<string, BuiltinProvider>` | none | Sign-in providers, keyed by provider id and tagged with their `type`. Required with `store: 'builtin'`. |
| `users` | `UserPoolOptions` | none | The shape of the user pool. `store: 'builtin'` accepts `users.groups` only. |
| `users.signInWith` | `('username' \| 'email' \| 'phone')[]` | `['username', 'email']` | What a user types as their username. Fixed once the pool exists. |
| `users.caseSensitive` | `boolean` | `true` | Whether usernames and sign-in emails match case-sensitively. Fixed once the pool exists. |
| `users.attributes` | `UserAttribute[]` | none | Custom attributes: `{ name, type?, mutable?, required?, userWritable? }`. Additive only. |
| `users.groups` | `(string \| { name, description?, precedence? })[]` | none | Groups to create: the roles `requireRole` accepts. |
| `users.authFlow` | `'USER_PASSWORD_AUTH' \| 'USER_AUTH'` | `'USER_PASSWORD_AUTH'` | `'USER_AUTH'` is required for passkeys and choice-based or passwordless sign-in, and needs a `featurePlan` above `'lite'`. |
| `users.preferredChallenge` | `'PASSWORD' \| 'EMAIL_OTP' \| 'SMS_OTP' \| 'WEB_AUTHN'` | none: the user picks a factor | The first factor `signIn` requests under `'USER_AUTH'`. `'EMAIL_OTP'` needs `email`. |
| `users.deviceTracking` | `{ challengeRequiredOnNewDevice?, deviceOnlyRememberedOnUserPrompt? }` | none | Remember devices to skip MFA on a known device. |
| `mfa` | `'off' \| 'optional' \| 'required' \| MfaOptions` | `'off'` | MFA for email + password users. A string is shorthand for `{ mode }`. Default store only. |
| `mfa.types` | `('SMS' \| 'TOTP' \| 'EMAIL')[]` | `['SMS', 'TOTP']` | The permitted second factors. `'EMAIL'` needs `email`. |
| `mfa.totpIssuer` | `string` | the id of the root `Scope` | The name authenticator apps show next to the codes. |
| `passkeys` | `false \| { relyingPartyId, origins, userVerification? }` | `false` | WebAuthn passkeys. Needs `users.authFlow: 'USER_AUTH'` and a `featurePlan` above `'lite'`, both checked at synth. `userVerification` is `'preferred'` (default) or `'required'`. Default store only. |
| `session` | `SessionOptions` | none | Session and token lifetimes ([Session lifetime and refresh tokens](#session-lifetime-and-refresh-tokens)). |
| `redirects.callbackPath` | `string` | `'/cdk-blocks/auth/callback'` | Must start with `/cdk-blocks/auth/`. |
| `redirects.signOutPath` | `string` | `'/cdk-blocks/auth/signout'` | Must start with `/cdk-blocks/auth/`. |
| `redirects.postSignInPath` | `string` | `'/'` | Where the browser lands after a federated sign-in. |
| `redirects.postSignOutPath` | `string` | `'/'` | Where the browser lands after a federated sign-out. A same-origin path. |
| `redirects.allowedRelayOrigins` | `RelayOrigin[]` | `[]` | Origins a relay sign-in may return to, each built with `relayOrigin()`. Loopback and the API's own origin are always allowed. |
| `hostedUi.domainPrefix` | `string` | derived from the block's `fullId` | Prefix of the Cognito domain. Create-only. Default store only. |
| `admin` | `{ actions?: ('groups' \| 'lifecycle')[] }` | omitted: no `auth.admin` | Enables `auth.admin` and its IAM grant. `actions` scopes both; without it everything is granted. Default store only. |
| `allowBearerAuth` | `boolean \| { clientIds }` | `false` | Accept `Authorization: Bearer` access tokens ([Bearer tokens](#bearer-tokens-allowbearerauth)). The object form is default store only. |
| `userPool` | `Auth.fromExisting(userPoolId, clientId?)` | the block creates a pool | Wrap an existing Cognito user pool. Default store only. |
| `featurePlan` | `'lite' \| 'essentials' \| 'plus'` | `'essentials'` | The Cognito feature plan, a pricing decision ([The sign-in methods](#the-sign-in-methods)). Default store only. |
| `email` | `EmailSenderOptions` | Cognito's default sender | Send the pool's email through Amazon SES ([Sign-up and email delivery](#sign-up-and-email-delivery)). Default store only. |
| `validateUser` | `(candidate) => Promise<void>` | none | Policy hook for every sign-up and sign-in ([Reject sign-ups and sign-ins](#reject-sign-ups-and-sign-ins-with-validateuser)). |
| `onSignIn` | `(user, context) => Promise<void>` | none | Called after a successful sign-in. Throwing rolls the sign-in back. |
| `onSignOut` | `(user, context) => Promise<void>` | none | Called before the session is destroyed. Errors are logged and never block sign-out. |
| `removalPolicy` | `'destroy' \| 'retain'` | the stack's `defaults.removalPolicy` | What happens to the user pool and the session table when the block leaves the stack. |
| `deletionProtection` | `boolean` | the stack's `defaults.deletionProtection` | Deletion protection on the user pool and the session table. |
| `logger` | `ChildLogger` | a `Logger` at `error` level | Where the block logs. |
| `audit` | `boolean \| ChildLogger` | `false` | Write a log line for each session lifecycle event ([Audit records](#audit-records)). |
| `codeDelivery` | `(username, code, purpose) => Promise<void>` | none | Local only: called with every verification code ([Local development](#local-development)). Default store only. |
| `totpVerification` | `'any' \| 'rfc6238'` | `'any'` | Local only: how authenticator-app codes are checked ([Local development](#local-development)). Default store only. |

## Sign-out and password reset

- `signOut()` clears the session cookie first, then deletes the session row. Deleting the row is what stops a copied cookie from authenticating.
- If that delete fails (a transient session-store error), `signOut()` rejects with `AuthErrors.SignOutIncomplete` (`SignOutIncompleteException`, 503): this device is signed out, but the session is not. `setAuthState({ action: 'signOut' })` returns a signed-out state with that `errorName`, and `POST /cdk-blocks/auth/signout` answers `503 { error, name }` to an API client.
- On AWS, signing out a user of a default-store `providers` entry (social, SAML, `type: 'oidc'`) also ends the Cognito managed-login session, so the next sign-in asks the provider again.
- Once `confirmResetPassword` (or the `createApi()` action of that name) succeeds, every session the user had is rejected from the next request on, with 401 `NotAuthenticatedException` and the cookie cleared, locally and on AWS. The user signs in again with the new password.
- On AWS the reset also revokes the user's Cognito refresh tokens, so an Amplify or native client using bearer tokens can't refresh. An access token it already holds stays valid until it expires (1 hour by default).
- If the password changed but ending the sessions failed, `confirmResetPassword` throws a 5xx: reset again.
- `updatePassword` (a signed-in password change) and `auth.admin.setUserPassword` leave other sessions signed in. After an admin password set, call `auth.admin.revokeUserSessions(username)` if they should end.

## Bearer tokens (`allowBearerAuth`)

With `allowBearerAuth: true`, the guards also accept `Authorization: Bearer <access token>` from a hand-written native or CLI client:

- On a `store: 'builtin'` block: the provider's access token, the one `/cdk-blocks/auth/exchange` returns and `/cdk-blocks/auth/exchange/refresh` renews.
- On the default store: a user-pool user's Cognito access token.
- With `allowBearerAuth: { clientIds }` (default store only): also access tokens from other app clients of the same pool, for a frontend that signs in with an Amplify client library ([below](#planning-to-use-amplify-client-libraries)).
- The session cookie wins when a request carries both.
- A bearer token stays valid after `signOut()` until it expires.
- The CDK Blocks native SDKs use the session cookie, not a bearer token.

Details: [DESIGN.md](./DESIGN.md#bearer-tokens-allowbearerauth--bearerts).

## Changes the block refuses

Cognito cannot apply some changes to an existing user pool. The block refuses them at synth, against a baseline file it writes to `cdk-blocks/baselines/`, and again at deploy, before the pool is updated. Commit the baseline file.

- Refused at synth and at deploy: a change to the sign-in attributes (`users.signInWith`), to username case sensitivity (`users.caseSensitive`) or to the required attributes, and changing or removing a custom attribute.
- Refused at synth, once a committed baseline records the pool: a change that would remove the pool. That includes renaming or deleting the `Auth` block, which would make CloudFormation delete the pool and every user in it ([details](./DESIGN.md#renaming-or-removing-an-auth-block)).
- A block's first synth has nothing to compare against: if it records no pool, synth only warns.
- Re-baseline deliberately with `BLOCKS_AUTH_REBASELINE=<block fullId>`.
- The baseline advances when you synthesize, not when you deploy. Reverting a change you synthesized but never deployed is refused too; the error then gives the re-baseline command.

Details: [DESIGN.md](./DESIGN.md#immutability-guard).

## Sign-up and email delivery

Every self-service sign-up confirms the email address with an emailed code. With `emailPassword.autoSignIn` (on by default), the user is then signed in without typing their password again — the code itself is still required.

By default, the sign-up form hides whether the account exists. A direct call to `auth.signUp()` always throws `UsernameExistsException` for an existing user. Confirmation, resend and password reset mask account state in both the UI and direct method calls. Set `emailPassword.revealExistingUsers: true` to receive the more specific errors on those paths and in the sign-up form.

Cognito's default email sender is limited to 50 emails per day (confirmation, password-reset and email-MFA codes all count). That is enough for development, not for production. Before launch, send through your own Amazon SES identity with `email`:

```ts
import { Auth } from '@aws-cdk-blocks/bb-auth';

const auth = new Auth(scope, 'auth', {
  email: { fromAddress: 'no-reply@example.com', fromName: 'Example App' },
});
```

- **Verify the sender in SES first,** in the pool's Region (or set `sesRegion`): the address itself, or its domain with `sesVerifiedDomain: 'example.com'`. A new SES account is in the sandbox and only delivers to verified recipients, so request SES production access before real users sign up. The same verified address can serve an `EmailClient` (its `fromAddress`).
- **Optional:** `replyTo`, and `configurationSetName` for SES event publishing or a dedicated IP pool.
- **It also unlocks the email factors:** email MFA (`mfa: { types: ['EMAIL', …] }`) and `users.preferredChallenge: 'EMAIL_OTP'` need an SES sender, and synth refuses them on a pool this block creates without one.
- **Safe to add later:** it updates the pool in place, and no user, session or token is affected. On that first deploy Cognito creates its email service-linked role, so the deploying role needs `iam:CreateServiceLinkedRole` (CDK's default deployment role has it).
- Only for a pool this block creates. With `userPool: Auth.fromExisting(…)`, configure SES on that pool yourself.
- Locally (`npm run dev`) `email` has no effect: codes go to `codeDelivery`, without SES.

## Password policy

`emailPassword.passwordPolicy` sets what a password needs. Every field is optional, and a field you leave out keeps its default:

| Field | Default | A password needs |
|---|---|---|
| `minLength` | `8` | at least this many characters |
| `requireUppercase` | `true` | an uppercase letter |
| `requireLowercase` | `true` | a lowercase letter |
| `requireDigits` | `true` | a digit |
| `requireSymbols` | `true` | a symbol |

The recipe [Tell the user what a password needs](#tell-the-user-what-a-password-needs) sets `{ minLength: 12, requireSymbols: false }` and shows the error on sign-up.

- **The range of `minLength`:** 6 to 99, as Cognito accepts. The block does not check it, and the local user pool enforces any number. So `minLength: 3` works under `npm run dev`, and the synth for a deploy fails with `minLength for password must be between 6 and 99`.
- **Where it is enforced:** every call that sets a password. On AWS the user pool the block creates enforces the policy. Locally (`npm run dev` and tests) the local user pool checks the same rules, with the two differences below. The calls:
  - `signUp`, `confirmResetPassword` and `updatePassword`;
  - the new-password answer to `confirmSignIn` (`CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`, which an administrator-created user's first sign-in asks for);
  - the `temporaryPassword` of `auth.admin.createUser`, and `auth.admin.setUserPassword`;
  - the `setAuthState` actions that call them (`signUp`, `confirmSignIn`, `confirmResetPassword`).
- **A generated temporary password, locally:** `auth.admin.createUser` without `temporaryPassword` gets a generated 16-character password, and the local user pool checks it against the policy too. With `minLength` above 16, that call throws `InvalidPasswordException` locally, while Cognito generates a password that fits. Pass a `temporaryPassword` that fits the policy.
- **What the client receives:** a password that breaks the policy is rejected with `InvalidPasswordException` (`AuthErrors.InvalidPassword`) and status 400. The message describes the whole policy rather than the rule the password broke, and it is the same locally and on AWS. For the recipe's policy it is `Password must be at least 12 characters and include an uppercase letter, a lowercase letter and a number.`
- **How to branch on it:** on the server, match a thrown error with `isAuthError(e, AuthErrors.InvalidPassword)`; in browser app code, use `isBlocksError(e, 'InvalidPasswordException')`. Through `setAuthState` the error is retriable. The returned state carries `retriable: true`, `errorName: 'InvalidPasswordException'` and the message as `error`, so the form stays on the current step. Branch on that state with `hasAuthError`, as the recipe does.
- **An imported pool:** with `userPool: Auth.fromExisting(…)`, the block doesn't create the pool, so the pool's own policy applies on AWS. The local user pool still checks `emailPassword.passwordPolicy` (or the defaults), so a password can pass under `npm run dev` and fail on AWS, or the reverse. Set `passwordPolicy` to the policy of the imported pool to make them agree. The message is the fixed `Password does not meet the password policy`, locally and on AWS.

## Reject sign-ups and sign-ins with `validateUser`

`validateUser` is called before any user is created and before any session is issued, whatever the mechanism. Throw to reject; a thrown `ApiError` reaches the client by its `name` and message.

```typescript
import { ApiError, Auth, AuthErrors } from 'aws-cdk-blocks';

const auth = new Auth(scope, 'auth', {
  validateUser: async ({ email }) => {
    if (!email?.endsWith('@example.com')) {
      throw new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
    }
  },
});
```

- `phase: 'signUp'` runs before a user-pool user is created: in `auth.signUp()` and `auth.admin.createUser()`, in your request.
- On AWS, setting the option also attaches a Cognito PreSignUp trigger to the pool. The trigger runs the same callback in your backend Lambda for users the app did not create itself: a `SignUp` sent straight to Cognito with the app client id, an `AdminCreateUser` from the console or CLI, and the first sign-in of a user of a `providers` entry (social, SAML or `type: 'oidc'`).
- A sign-up made through `auth.signUp()` is checked once, not twice. The trigger never confirms or verifies a user.
- `phase: 'signIn'` runs on every sign-in, so a Cognito-federated user's first sign-in sees both phases. A `store: 'builtin'` block creates no user, so its `validateUser` only ever sees `phase: 'signIn'` (no trigger is provisioned for it): reject there to prevent the session.
- A bearer token (`allowBearerAuth`) is verified per request and does not run `validateUser`; gate per request (e.g. check `user.attributes.email`) when you rely on it.
- Keep it fast: Cognito waits at most 5 seconds for the trigger, and a cold start of your Lambda counts. If it does not answer in time the sign-up fails (no user is created). Avoid slow network calls in `validateUser` (cache any allowlist you fetch); if cold starts alone come close to the limit, configure provisioned concurrency on the backend Lambda.
- A pool you wrap with `userPool: Auth.fromExisting(...)` gets no trigger (its triggers are yours to manage); synth warns, and the in-process checks still run. Wrapping a pool another `Auth` in the same app creates (e.g. a second block for `admin`) is fine: the trigger stays with the block that created the pool and keeps running its `validateUser`. Details: [DESIGN.md](./DESIGN.md#validateuser-and-the-presignup-trigger).

## Errors

`Auth` throws `ApiError`s. Each `name` is a value of `AuthErrors`, and `setAuthState` returns the same name as `errorName` on a failed `AuthState`. The names are listed in the [`auth-common` README](../auth-common/README.md#auth-error-names-autherrors).

- In browser app code, match a thrown error with `isBlocksError(e, 'NotAuthenticatedException')` from `aws-cdk-blocks/client`. The auth-specific guard `isAuthError(e, AuthErrors.NotAuthenticated)` matches the same name. Both `isAuthError` and `AuthErrors` are available from `aws-cdk-blocks` in either environment, or directly from `@aws-cdk-blocks/auth-common`.
- Match a returned state with `hasAuthError(state, 'InvalidPasswordException')` from `aws-cdk-blocks/client`.
- An error `Auth` does not recognise becomes `InternalErrorException`. An `ApiError` your own `validateUser` or `onSignIn` hook throws keeps its name and status.

The default HTTP status of each name:

| HTTP status | `error.name` |
|---|---|
| 401 | `NotAuthenticatedException`, `NotAuthorizedException`, `ReauthenticationRequiredException`, `TokenExpiredException` |
| 404 | `UserNotFoundException`, `ResourceNotFoundException` (`AuthErrors.GroupNotFound`) |
| 409 | `UsernameExistsException`, `EmailPasswordNotEnabledException`, `NoFederatedProviderException`, `PasskeysNotEnabledException`, `MfaNotEnabledException` |
| 429 | `LimitExceededException`, `TooManyRequestsException`, `TooManyFailedAttemptsException` |
| 500 | `InternalErrorException`, `InsecureTransportException` |
| 503 | `SignOutIncompleteException` |
| 400 | Every other name |

Some operations return a different status for the same name. For example:

- 403 `NotAuthorizedException`: `requireRole`, or `protect` with `role`, for a signed-in user outside the group.
- 501 `ProviderUnavailableException`: a provider that is not available in this runtime, such as a social provider under `npm run dev`.
- 502 `ProviderUnavailableException`: a direct OIDC provider's discovery document does not match its configured issuer.
- 501 `InvalidParameterException`: `rememberDevice` on AWS.

Use `state.retriable`, not `errorName` alone, to decide whether to keep the form on the current step. `Auth` marks mapped service errors named `CodeMismatchException`, `EnableSoftwareTokenMFAException`, `InvalidParameterException`, `InvalidPasswordException` or `InternalErrorException` as retriable. An explicitly thrown `ApiError` carries its own retry flag.

## Mode gates

- With `emailPassword: false`, or on a `store: 'builtin'` block, the email + password methods (`signUp`, `signIn`, `resetPassword`, …) are compile errors, and the error names the cause: `ERROR_emailPassword_is_disabled_on_this_Auth_instance`.
- With no federated provider configured, `getSignInUrl` is a compile error (`ERROR_no_federated_provider_is_configured`), and its `provider` argument only accepts configured provider ids.
- When the options set `mfa` to anything but `'optional'` / `'required'` (or omit it), the MFA methods (`setUpTotp`, `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`) are compile errors (`ERROR_mfa_is_off_on_this_Auth_instance`); when they configure no `passkeys` options object, so are the passkey methods (`ERROR_passkeys_are_not_enabled_on_this_Auth_instance`). With `mfa.types` listed inline, `updateMfaPreference` rejects a factor it leaves out (`ERROR_SMS_is_not_in_mfa_types`, and the same for `TOTP` / `EMAIL`).
- `auth.admin` is unusable unless the options include `admin: {}`: its methods are compile errors (`ERROR_admin_is_not_enabled__construct_Auth_with_admin_options`). With `admin: { actions: ['groups'] }`, the lifecycle methods are compile errors (`ERROR_admin_action_not_granted`), and vice versa.
- `signIn`, `confirmSignIn` and `autoSignIn` return only the `nextStep` values the configuration can produce, so a `switch` on `nextStep.name` handles just those: the MFA steps need `mfa` on (and each factor's steps that factor in `mfa.types`), `CONFIRM_SIGN_IN_WITH_WEB_AUTHN` needs `passkeys`, and the first-factor steps need `users.authFlow: 'USER_AUTH'`. With `userPool: Auth.fromExisting(…)` every step stays, since the wrapped pool's own settings decide them. The full list is in `SignInNextStep`'s documentation.
- The same gates apply to the input of `authApi.setAuthState(…)` and `submitAuthAction(authApi, …)` (`AuthActionInputOf<O>`), in the frontend too: with `emailPassword: false`, `authApi.setAuthState({ action: 'signIn', … })` and `submitAuthAction(authApi, { action: 'signIn', … })` are compile errors.
- As actions, `setUpTotp` / `verifyTotpSetup` also need `'TOTP'` in `mfa.types`, and `confirmSignIn` takes only the challenges that answer the steps above (`mfaType` one of `mfa.types`).
- A narrowly configured instance is still assignable to the plain `Auth` type, so helpers typed `(auth: Auth)` keep working. On the plain type, federation and `auth.admin` are closed (type such a helper with the instance's own type, `typeof auth`), while the email + password, MFA and passkey methods stay callable and are checked at runtime. That includes `new Auth(scope, 'auth')` with no options, which the compiler cannot tell apart from the plain type.

The gates are TypeScript-only. A native client (Swift, Kotlin, Dart) gets the types from the OpenRPC spec in their wide form, whatever the options:

- `setAuthState`'s input has every action and `confirmSignIn` challenge, a sign-in result's `nextStep` every step, and `getMfaPreference` / `updateMfaPreference` every factor. Differently configured blocks generate the same native type.
- `AuthenticatedUser` (from `requireAuth`, `getCurrentUser` or a sign-in result your API returns) keeps its block's own schema: `signInProvider` lists that block's provider ids and `groups` its declared groups. Blocks whose users have the same schema share one `AuthenticatedUser` type.

The server enforces each block's configuration, whatever the caller's language. A method throws the error; `setAuthState` returns it as an error state:

| Call | Error |
|---|---|
| An email + password method or action with email + password off | `EmailPasswordNotEnabledException` (409) |
| A federated method with no provider configured | `NoFederatedProviderException` (409) |
| A passkey action, or the `webauthn` challenge, without `passkeys` | `PasskeysNotEnabledException` (409) |
| An MFA method, action or challenge with MFA off | `MfaNotEnabledException` (409) |
| A factor outside `mfa.types`, or a `USER_AUTH` challenge without `users.authFlow: 'USER_AUTH'` | `InvalidParameterException`, naming the option |
| A sign-in step the options do not enable | `InternalErrorException`, naming the step |

The cause is not on the first line of the error. A gated call is an arity error, and the gate's name is in the related-information line (`auth.signIn('alice', 'pw', context)` with `emailPassword: false`):

```
TS2554: Expected 4 arguments, but got 3.
  Arguments for the rest parameter 'ERROR_emailPassword_is_disabled_on_this_Auth_instance' were not provided.
```

Editors and `tsc --pretty` show both lines; plain `tsc` output (as in CI logs) shows only the first. Ignore the "add an argument" suggestion: hover the method, and its last parameter names the option the call needs. Each gate reads the same way, with its own `ERROR_` name.

Pass options inline, or keep them in a variable declared `as const satisfies AuthOptions`. Plain `satisfies AuthOptions` keeps the gates but widens arrays: with `users: { groups: ['admins', 'readers'] }`, `user.groups` becomes `string[]` and `requireRole` accepts any string, with no error anywhere. A variable annotated `: AuthOptions` loses every narrowing.

```typescript
import { Auth, type AuthOptions } from '@aws-cdk-blocks/bb-auth';

const options = {
  store: 'builtin',
  providers: { corp: { type: 'oidc', issuer: 'https://login.example.com', clientId: 'my-client-id' } },
  users: { groups: ['admins', 'readers'] },
} as const satisfies AuthOptions;
const auth = new Auth(scope, 'auth', options);
// user.groups: ('admins' | 'readers')[]
```

**Troubleshooting: options in a plain `const`.** Without `as const`, TypeScript widens every string in the variable (`store: 'builtin'` becomes `store: string`), so no arm of `AuthOptions` matches and the error points somewhere unexpected: on a `'builtin'` block, `Type 'string' is not assignable to type '"cognito"'`; on the default store, a social entry reports `Property 'issuer' is missing in type … but required in type 'CognitoOidcProvider'`. Neither is the real problem. Declare the variable `as const satisfies AuthOptions`, as above.

### What is checked when

The compiler checks the option combinations:

- With `store: 'builtin'`, `emailPassword` (other than `false`), `mfa`, `passkeys`, `admin`, `userPool`, `users.signInWith` and the other user-pool options are compile errors whose type names the fix (`ERROR_needs_store_cognito<'emailPassword'>`). So is a `type: 'google'` or `type: 'saml'` entry.
- On the default store, `stubIdp()`, `github()` and a `type: 'oidc'` entry without `clientSecret` are compile errors.
- With `store` set, autocomplete for `type:` lists only that store's types. With `store` omitted it lists every type, and the compiler rejects `'oauth2'` / `'stub'`.

The constructor checks the same rules again (in `npm run dev`, at synth and in Lambda) with a readable message. It also rejects what the compiler cannot see:

- Options from a variable annotated `: AuthOptions`, built from JSON or env, or cast.
- A social entry keyed differently from its `type` (`providers: { gmail: { type: 'google', … } }`).
- A `store: 'builtin'` block with an empty `providers`.
- `mfa` (other than `'off'`), `passkeys` or `users.deviceTracking` with `emailPassword: false`: they apply only to email + password users. The error names both options.
- An option `Auth` does not recognise. The error names each unknown option's path with a suggestion (`` `preferredChallenge`: it is not an option here; did you mean `users.preferredChallenge`? ``). TypeScript does no excess-property check on the inferred options type ([why](./DESIGN.md#unknown-options)).
- A boolean option that is not `true` or `false` (or left out), such as `selfSignUp: 0` or `passkeys: 'false'` from untyped code.

## Audit records

Set `audit: true` to write one log line for each session lifecycle event, so you can see and alarm on auth activity. It is off by default.

```typescript
const auth = new Auth(scope, 'auth', { audit: true });
```

| `event` | Written when |
|---|---|
| `auth.session.issued` | A session is issued, for any sign-in method |
| `auth.signin.failed` | An email + password sign-in or a challenge answer (an MFA, email or SMS code) fails, a provider's callback fails, `validateUser` / `onSignIn` rejects the sign-in, or the sign-in is refused because the session cookie could not be sent securely |
| `auth.signout` | `signOut` ends a session |
| `auth.sessions.revoked` | A password reset or `admin.revokeUserSessions` ends all the user's sessions, or `deleteUser` ends the current one (the user's other sessions end on their next request, without a record) |

Each line is the record's `event` as the message plus the fields of `AuthAuditRecord`: `block`, `provider`, `sub`, `outcome`, and on some events `username`, `reason` and the error name. `outcome` is `success`, `failure` (a refused sign-in) or `incomplete` (a sign-out or revocation that failed part-way, so some sessions may still be valid). No line ever holds a password, code, token, session id, email or error message.

Users are identified by `sub`. On the default Cognito store that is the id CloudTrail records for Cognito calls, so the two can be joined. A directly federated session's `sub` is `<issuer>:<sub>`, which CloudTrail never sees, and a password-reset record carries the pool `username` instead.

`audit: true` writes through its own `info`-level logger, so the lines appear in the function's CloudWatch log group however quiet `logger` is. Pass a logger instead (`audit: myLogger`) to send them somewhere else; it must accept `info`, or every record is dropped without an error.

To alarm on failed sign-ins, create a CloudWatch metric filter on the log group with the pattern `{ $.event = "auth.signin.failed" }`, or `{ $.event = "auth.signin.failed" && $.block = "<fullId>" }` to count one block of several. Alarm on the metric's `Sum` over a period (for example 100 in 5 minutes) with `treatMissingData: notBreaching`: the filter has no data points while nothing fails, so without it the alarm sits in `INSUFFICIENT_DATA` on a quiet day.

Records come from this block, so they don't include failed attempts on Cognito's managed login page or calls a client makes to Cognito directly; CloudTrail has those. Design details: [DESIGN.md](./DESIGN.md#audit-records-audit).

## Local development

`npm run dev` and tests run email + password against a local user pool in `.cdk-blocks/local/data/<fullId>/state.json`, with no AWS account. Local passwords are stored there in plain text (`.cdk-blocks/local/data/` is git-ignored): **never use real credentials locally.**

| | Locally | On AWS |
|---|---|---|
| Verification codes (sign-up, password reset, MFA, attribute verification) | Not sent. Each is written to `.cdk-blocks/local/data/<fullId>/last-code.json` as `{ username, code, purpose }` and passed to the `codeDelivery` hook. | Cognito emails or texts them. `codeDelivery` is ignored. |
| `email` (SES sender) | No effect. | Cognito sends through your SES identity. |
| Authenticator-app (TOTP) codes | Any 6 digits pass, unless `totpVerification: 'rfc6238'`. | Cognito verifies every code. |
| Passkeys | The signature is not verified. | Verified. |
| `providers` of a default-store block (social, SAML, `type: 'oidc'`) | Unavailable: sign-in answers `501` `ProviderUnavailableException` ([step 3 of the social sign-in recipe](#social-sign-in-the-client-secret-and-the-callback-url)). | Cognito managed login. |
| `stubIdp()` | Served by the dev server. | Sandbox deployments only ([The stub IdP](#the-stub-idp-stubidp)). |
| `rememberDevice` | Records the device under a synthetic device key. | Throws `501` ([why](./DESIGN.md#known-gaps-documented-not-built)). |
| Password policy | `minLength` is not range-checked, and a generated temporary password is checked against the policy ([Password policy](#password-policy)). | `minLength` must be 6 to 99. Cognito generates a temporary password that fits. |

The full list is the mock-vs-AWS table in [DESIGN.md](./DESIGN.md#mock-vs-aws-behaviour-differences).

In a test, read a code with `getLastAuthCode(username)` rather than the file: the path follows the scope and block names ([recipe](#end-to-end-tests-emailed-codes-and-two-users-at-once)). The `codeDelivery` hook receives every code:

```typescript
const auth = new Auth(scope, 'auth', {
  codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
});
```

To check authenticator-app codes locally as Cognito does (RFC 6238: HMAC-SHA-1, 6 digits, 30-second steps), set the local-only `totpVerification: 'rfc6238'`. A wrong secret or `otpauth://` URI then fails in `npm run dev` and in tests, not only on a deployed pool. Tests answer with `totpCodeFor(sharedSecret)` from `aws-cdk-blocks/utils` (also `@aws-cdk-blocks/bb-auth/testing`), the code an authenticator app would show:

```typescript
// cdk-blocks/index.ts
const auth = new Auth(scope, 'auth', {
  mfa: { mode: 'optional', types: ['TOTP'] },
  totpVerification: 'rfc6238', // local only; the default 'any' accepts any six digits
});

// test/mfa.test.ts
import { totpCodeFor } from 'aws-cdk-blocks/utils';

const setup = await authApi.setAuthState({ action: 'setUpTotp' });
const sharedSecret = setup.actions[0]?.fields.find((f) => f.name === 'sharedSecret')?.defaultValue ?? '';
await authApi.setAuthState({ action: 'verifyTotpSetup', code: totpCodeFor(sharedSecret) });
```

## Sign-in UI

`@aws-cdk-blocks/bb-auth/ui` re-exports the shared sign-in UI from `@aws-cdk-blocks/auth-common/ui` (`Authenticator`, `AccountMenuBar`, `AuthenticatedContent`, `MfaSettings`, `onAuthChange`, `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`) and adds `authOverrides()`, which type-checks `Authenticator` options against `Auth`'s action, next-step and field names:

```typescript
import { Authenticator, authOverrides } from '@aws-cdk-blocks/bb-auth/ui';
import { authApi } from 'cdk-blocks';

document.body.appendChild(Authenticator(authApi, authOverrides({
  hideActions: ['signUp'],
  actions: { signIn: { fields: { username: { label: 'Email', autocomplete: 'email' } } } },
})));
```

Federated providers appear as `signIn:<id>` actions that carry a `url`. The `Authenticator` renders them as plain "Sign in with …" buttons, and the RPC surface stays `getAuthState` / `setAuthState`.

In a custom UI, navigate to the action's `url`: `setAuthState({ action: 'signIn:<id>' })` answers an `InvalidParameterException` state. The typed action names are `FederatedActionNameOf<O>`, `` `signIn:${id}` `` for each configured provider id:

```typescript
// cdk-blocks/index.ts — the backend
import { Auth, type AuthOptions, type FederatedActionNameOf, Scope } from 'aws-cdk-blocks';

const scope = new Scope('app');
const authOptions = {
  store: 'builtin',
  providers: { okta: { type: 'oidc', issuer: 'https://dev-12345.okta.com', clientId: 'my-client-id' } },
} as const satisfies AuthOptions;
const auth = new Auth(scope, 'auth', authOptions);

export const authApi = auth.createApi();
/** The `signIn:<id>` action names, for the frontend. */
export type ProviderAction = FederatedActionNameOf<typeof authOptions>;
```

```typescript
// src/main.ts — the browser
import { authApi, type ProviderAction } from 'cdk-blocks';

const okta: ProviderAction = 'signIn:okta'; // 'signIn:otka' is a compile error
const state = await authApi.getAuthState();
const action = state.actions.find((a) => a.name === okta);
if (action?.url) window.location.assign(action.url);
```

`AuthState.user` is typed by the block's options too (`AuthStateUser<O>`: the signed-in `AuthenticatedUser` without the server-only `claims` and `federatedIdentity`), and so is the user every UI helper hands you, so the frontend reads roles and attributes without an extra endpoint. `AuthUserOf<typeof authApi>` names the type:

```typescript
// src/main.ts — the browser
import { onAuthChange } from 'aws-cdk-blocks/ui';
import { authApi } from 'cdk-blocks';

onAuthChange(authApi, (user) => {
  // With users: { groups: ['admins', 'readers'] }: user.groups is ('admins' | 'readers')[]
  document.body.classList.toggle('admin', user?.groups.includes('admins') ?? false);
});
```

To mount the UI and gate the app behind a session, see [Quick start](#quick-start). The components are documented in the [`auth-common` README](../auth-common/README.md).

The test ids e2e suites target (`authenticator-username`, `authenticator-action-signIn`, …) are listed in [Customizing Auth UI](./CUSTOMIZING-AUTH-UI.md#test-hooks), which also covers restyling, replacing or driving the forms yourself.

## Frontend on a different origin

When the frontend and the API share an origin (`Hosting`'s default), the `Authenticator`'s "Sign in with …" links are all you need. When the frontend is served from another origin, for example `https://app.example.com` calling `https://api.example.com`, use the browser redirect client from `@aws-cdk-blocks/bb-auth/browser-client` (also exported from `aws-cdk-blocks/ui`). It signs in with a federated provider through the block's own routes, then reads and ends the session:

```typescript
import { createAuthClient } from '@aws-cdk-blocks/bb-auth/browser-client';

const auth = createAuthClient<'okta'>({
  baseUrl: 'https://api.example.com',            // where /cdk-blocks/auth/* is served
  redirectUri: 'https://app.example.com/return', // the page that calls handleSignInRedirect()
});

// A "Sign in" button:
await auth.signInWithRedirect({ provider: 'okta', customState: location.pathname });

// On the return page (safe to call on every page load: null when there is nothing to finish):
const result = await auth.handleSignInRedirect();
if (result?.customState) history.replaceState(null, '', result.customState);

const session = await auth.fetchAuthSession();
if (session.signedIn) render(session.user.displayName);

await auth.signOut({ endProviderSession: true });
```

On the backend, allow the frontend's origin in three places:

```typescript
new Auth(scope, 'auth', {
  store: 'builtin',
  providers: { okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1' } },
  redirects: { allowedRelayOrigins: [relayOrigin('https://app.example.com')] }, // where sign-in may return
  session: { crossDomain: true }, // only when the two are on different registrable domains
});
// …and the frontend origin in the stack's CORS allowlist: `defaults.allowedOrigins` (see the core README).
```

- **Session and `baseUrl`.** The session is the block's usual `HttpOnly` cookie. No token is stored in JavaScript or put in a URL. The provider's `redirect_uri` is `<baseUrl><callbackPath>`, so `baseUrl` must be the origin your providers have registered (for providers federated through Cognito, the app origin the block registers on its managed-login client).
- **Local development.** A frontend at `http://127.0.0.1:<port>` is always allowed, and the dev server's CORS already admits it. Open both the frontend and the dev server at `127.0.0.1` (not `localhost`), so they are the same site and the session cookie needs no `crossDomain`.
- **Which providers.** Every `providers` entry, on either store, since each signs in by redirect: `type: 'oidc'`, `github()` / `customOauth2()` and `stubIdp()` (locally) on a `store: 'builtin'` block; social, SAML and `type: 'oidc'` on the default store. Email and password sign-in keeps using `authApi` (`getAuthState` / `setAuthState`), which works across origins with the same CORS and cookie settings.
- **Sign-out.** `signOut()` ends the block's session. When the provider keeps its own session (Cognito managed login, or an OIDC provider with an `end_session_endpoint`), it also returns `logoutUrl`; `endProviderSession: true` navigates there. The provider then returns the browser to `redirects.postSignOutPath` on the API's origin.
- **Names.** The methods follow Amplify JS v6 (`signInWithRedirect`, `fetchAuthSession`, `getCurrentUser`, `signOut`); the user and the errors are the block's own (for example, `isBlocksError(e, 'InvalidRelayException')`). `user.userId` is the block's id; the Cognito `sub` that Amplify's `getCurrentUser().userId` returns is `user.userSub`.

## Native apps (Swift, Kotlin, Dart)

A native app signs in with a federated provider through the SDK's OIDC client, which uses the block's relay routes. Export the client next to `createApi()`:

```typescript
import { Auth, relayOrigin } from '@aws-cdk-blocks/bb-auth';
import { Scope } from '@aws-cdk-blocks/core';

const scope = new Scope('app');
const auth = new Auth(scope, 'auth', {
  store: 'builtin',
  providers: { okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1' } },
  redirects: { allowedRelayOrigins: [relayOrigin('myapp://auth')] }, // the app's return URL
});

export const authApi = auth.createApi();         // the sign-in state machine
export const oidcAuthApi = auth.createOidcApi(); // the native SDKs' OIDC client
```

`oidcAuthApi.getClient()` returns an `oidc/client` transferable: the block's routes and the providers available in this runtime. The generated native client (Swift, Kotlin and Dart) turns it into the SDK's OIDC client, and its `signIn` takes only the block's provider ids:

```swift
let oidc = try await blocks.oidcAuthApi.getClient() // OIDCClient<OidcAuthApi.GetClient.Provider>
let user = try await oidc.signIn(provider: .okta, relayTo: "myapp://auth", launcher: launcher)
```

```dart
final oidc = await blocks.oidcAuthApi.getClient(); // TypedOidcClient<OidcAuthApiApiGetClientProvider>
final user = await oidc.signInRelay(OidcAuthApiApiGetClientProvider.okta, launcher: launcher, relayTo: 'myapp://auth');
```

- **Return URL.** List the app's scheme in `redirects.allowedRelayOrigins`. Desktop loopback (`http://127.0.0.1:<port>`) is always allowed.
- **Several blocks.** Each block's client carries that block's own paths, so a second federated block with its own `redirects.callbackPath` and `signOutPath` gets a working client too.
- **Availability.** A provider that can't sign in here (managed login under `npm run dev`), or whose discovery fails, is left out of `providers` at runtime, so the others stay usable.
- **Restore on launch.** The client also carries the block's `sessionPath` (`GET` answers `{ user }` for a valid session cookie, 401 otherwise).
- **Web.** A browser receives the plain descriptor. A web frontend uses the `signIn:<id>` actions of `createApi()`, or `createAuthClient()` on another origin ([above](#frontend-on-a-different-origin)).

## Planning to use Amplify client libraries?

`Auth` signs users in on your backend: the browser talks to your API, and the session lives in an `HttpOnly` cookie. The Amplify client libraries (JavaScript, Swift, Android, Flutter) do the opposite: the app signs in directly against Amazon Cognito and holds the tokens itself. Both can share one user pool, so you can start with `Auth` and add an Amplify frontend later. A few choices decide whether that stays possible, and some of them are permanent:

- **Choose the pool's shape before real users sign up.** Cognito fixes how users sign in and whether names match case-sensitively when the pool is created; the block refuses a later change. Amplify Gen 2 pools sign in with the email address, matched ignoring case. Use the same shape (the `create-blocks-app` templates do):

  ```typescript
  const auth = new Auth(scope, 'auth', {
    users: { signInWith: ['email'], caseSensitive: false },
  });
  ```

  Unset, `users.signInWith` is `['username', 'email']` and `users.caseSensitive` is `true`.
- **Federate OIDC providers through Cognito if Amplify clients will sign in with them.** Amplify signs users in only through Cognito. A `type: 'oidc'` entry of a `store: 'builtin'` block creates no Cognito user, so moving that provider to a default-store block later gives each of its users a new `userId` and `userSub`. Put it on the default store from the start, or key your data on `user.federatedIdentity` (`{ providerId, sub }`), which is the same under both.
- **`federatedIdentity` on bearer requests.** On a bearer request from an extra client (`allowBearerAuth.clientIds`), `user.federatedIdentity` is set only on an email or phone pool (as the templates create).
- **Share `userSub`, not `userId`.** For a user-pool user, `user.userSub` is the Cognito `sub` — what Amplify's `getCurrentUser()` returns as `userId`. This block's `userId` is the Cognito username (Amplify's `username`).
- **Give the Amplify app its own app client, and accept its tokens.** Don't widen the block's own `client`: Amplify's default sign-in flow (SRP) is off on it by design. Give the Amplify app its own public client and list it in `allowBearerAuth.clientIds`, so the guards accept the **access** tokens it sends as `Authorization: Bearer`. (ID tokens are never accepted. With Amplify JS, send `(await fetchAuthSession()).tokens?.accessToken.toString()`.)

  A `clientIds` entry can be a literal id or a CDK token: the block forwards the list through its deployed config, so a token resolves at deploy time.

  **A pool Amplify Gen 2 created** (or any pool created elsewhere in the same CDK app): wrap it with `Auth.fromExisting` and pass the ids as tokens. The backend module is loaded while the CDK app synthesizes, so hand them over before creating the CDK Blocks backend:

  ```typescript
  // amplify/blocks.ts
  const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
  process.env.AMPLIFY_USER_POOL_ID = cfnUserPool.ref;        // CDK tokens, read at synth
  process.env.AMPLIFY_USER_POOL_CLIENT_ID = cfnUserPoolClient.ref;
  const blocks = await createBlocksBackend(blocksStack, sandboxMode);
  ```

  ```typescript
  // cdk-blocks/index.ts
  const auth = new Auth(scope, 'auth', {
    // At synth these are tokens; in the Lambda they're unset, and the block reads
    // the deployed pool and client ids from its own config.
    userPool: Auth.fromExisting(process.env.AMPLIFY_USER_POOL_ID ?? '', process.env.AMPLIFY_USER_POOL_CLIENT_ID),
    allowBearerAuth: true, // fromExisting's client id is accepted
  });
  ```

  A Gen 2 pool is deleted with its stack by default, so retain it before you hand it over.

  **A client of the block's own pool** is created after the block, so its id can't be passed to the constructor as a token. Add it in `cdk-blocks/index.cdk.ts`, then list the id the first deploy printed:

  <!-- doc-snippet: fragment — continues the CDK entry file after its `blocksStack` is created -->
  ```typescript
  // cdk-blocks/index.cdk.ts — after `const blocksStack = await BlocksStack.create(...)`
  import * as cdk from 'aws-cdk-lib';
  import * as cognito from 'aws-cdk-lib/aws-cognito';

  const pool = blocksStack.node.findChild('my-app').node.findChild('auth').node.findChild('pool');
  if (!(pool instanceof cognito.UserPool)) throw new Error('expected the Auth user pool');
  const web = pool.addClient('amplify-web', { generateSecret: false, authFlows: { userSrp: true } });
  new cdk.CfnOutput(blocksStack, 'AmplifyWebClientId', { value: web.userPoolClientId });
  ```

  ```typescript
  // cdk-blocks/index.ts
  const auth = new Auth(scope, 'auth', {
    users: { signInWith: ['email'], caseSensitive: false },
    allowBearerAuth: { clientIds: ['<AmplifyWebClientId from the stack output>'] },
  });
  ```
- **Hooks run on the backend's sign-in path only.** `validateUser`'s `phase: 'signUp'` check also covers a sign-up sent straight to Cognito, through the pool's PreSignUp trigger. `phase: 'signIn'`, `onSignIn` and `onSignOut` run only for sign-ins and sign-outs that go through this block; an Amplify app that signs in directly is not seen. Gate each request with `requireAuth` / `requireRole`, which accept its bearer tokens.

## Migrating from `AuthBasic`, `AuthCognito` or `AuthOIDC`

See [MIGRATION.md](./MIGRATION.md): per-block before → after code, what happens to deployed pools, users and sessions, and the codemod (`npx @aws-cdk-blocks/bb-auth migrate --dry-run`). The one rule: never change the block's id argument.
