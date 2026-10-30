# Auth

`Auth` is the single authentication Building Block for AWS Blocks: one import and one options object for email + password, social sign-in, generic OIDC and SAML.

Import it from `@aws-blocks/blocks` (or `@aws-blocks/bb-auth`), and its UI helpers from `@aws-blocks/blocks/ui` (or `@aws-blocks/bb-auth/ui`).

> **Coming from `AuthBasic`, `AuthCognito` or `AuthOIDC`?** `Auth` replaces all three. See [MIGRATION.md](./MIGRATION.md) for before → after code, what happens to deployed user pools, users and sessions, and the codemod.

## Recipes

Each recipe is a complete `aws-blocks/index.ts` (and, where the browser takes part, its frontend), and each compiles as written. Every guard is awaited: an API method is public until `await auth.requireAuth(context)` or `await auth.requireRole(context, …)` returns, and a guard that is not awaited protects nothing. To make that mistake impossible, define the namespace with `auth.protect` ([first recipe](#protect-every-method)).

### Protect every method

A method of `new ApiNamespace(...)` is public until it awaits a guard, so a forgotten guard, or one called without `await`, serves the data to anyone, and nothing warns you. Define the namespace with `auth.protect` instead. It takes two method factories: `methods`, which runs only after the session check and gets the signed-in user, and `public` (optional), for methods anyone may call.

```ts
// aws-blocks/index.ts
import { Auth, KVStore, Scope } from '@aws-blocks/blocks';

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
import { AuthErrors, isAuthError } from '@aws-blocks/blocks';
import { notesApi } from 'aws-blocks';

await notesApi.health(); // works signed out
try {
  await notesApi.addNote('hello');
} catch (e) {
  if (isAuthError(e, AuthErrors.NotAuthenticated)) {
    // signed out: show the sign-in UI
  }
}
```

- **A protected call** checks the session first, with `requireAuth(context)` (or `requireRole(context, role)`), so sessions, bearer tokens (`allowBearerAuth`) and live group reads work exactly as they do there, locally and on AWS. Only then does `protect` call `methods`, once, so nothing in it — the factory body included — runs for a caller who fails the check. No valid session: 401 `NotAuthenticatedException`. With `role`, a signed-in user outside the group: 403 `NotAuthorizedException`.
- **An anonymous call to a name that isn't public** gets the same 401, whether or not the method exists, so a signed-out caller can't list your protected methods. A signed-in caller gets "method not found" for a name `methods` doesn't define.
- **A public method** runs exactly as in a plain `ApiNamespace`. It has no `user`; call `auth.getCurrentUser(context)` in it for an optional one.
- **A name can't be in both** `public` and `methods`: that is a compile error (and an error at runtime for untyped JavaScript).
- The `ApiNamespace` options, such as `compute`, go in the last argument, next to `role`. You can still call `requireRole` inside a protected method for a stricter check on one method.

A lint rule is not a substitute. Biome's `noFloatingPromises` (a nursery rule) does not flag an un-awaited `auth.requireAuth(context)` or `auth.requireRole(context, …)`, because Biome does not infer their return types from the package. typescript-eslint's type-aware `no-floating-promises` does flag it, but only where you have set it up. `protect` doesn't depend on either.

### MFA with an authenticator app (TOTP)

Turn MFA on, then let a signed-in user enrol an authenticator app through two methods of your own:

```ts
// aws-blocks/index.ts
import { ApiNamespace, Auth, Scope } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  mfa: { mode: 'optional', types: ['TOTP'] },
});
export const authApi = auth.createApi();

export const account = new ApiNamespace(scope, 'account', (context) => ({
  /** Step 1: show `otpauthUri` as a QR code, or `sharedSecret` as a setup key. */
  async startTotpSetup() {
    const user = await auth.requireAuth(context);
    const { sharedSecret } = await auth.setUpTotp(context);
    const label = encodeURIComponent(`MyApp:${user.attributes.email ?? user.username}`);
    return { sharedSecret, otpauthUri: `otpauth://totp/${label}?secret=${sharedSecret}&issuer=MyApp` };
  },
  /** Step 2: the first code from the app. TOTP is then enrolled, and challenged at every sign-in. */
  async finishTotpSetup(code: string) {
    await auth.verifyTotpSetup(context, code);
    return auth.getMfaPreference(context);
  },
}));
```

The sign-in UI handles the challenge: the `Authenticator` asks for the 6-digit code at the next sign-in (and, with `mode: 'required'`, walks a user with no factor through TOTP setup mid-sign-in). Nothing else to write:

```ts
// src/main.ts
import { Authenticator } from '@aws-blocks/blocks/ui';
import { account, authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi));

// In your account settings page, once signed in:
const { otpauthUri } = await account.startTotpSetup(); // render it as a QR code
await account.finishTotpSetup('123456'); // the code the user typed
```

Locally the user pool accepts any 6-digit code (see [Local development](#local-development)); deployed, Cognito verifies it.

### Roles and an admin-only user list

Declare the groups, opt in to `auth.admin`, and gate the method with `requireRole`:

```ts
// aws-blocks/index.ts
import { ApiNamespace, Auth, Scope } from '@aws-blocks/blocks';

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

### The first admin

`requireRole(context, 'admin')` needs someone in `admin` already. Make the first one with the `users` command, once: sign up as yourself, then add your account to the group. It works the same on the local pool and on a deployed one:

```sh
# Local pool (.bb-data/): stop the dev server first (npm run dev:stop), start it again afterwards.
npx @aws-blocks/bb-auth users add-to-group you@example.com admin

# The pool a deployed stage owns, with your AWS credentials (--profile / --region, or AWS_PROFILE / AWS_REGION).
# Without --yes it checks the stack, the user and the group, prints what it would do, and changes nothing.
npx @aws-blocks/bb-auth users add-to-group you@example.com admin --stage prod --yes
```

- `<user>` is the username, or the user's **verified** email or phone number. An unverified one is refused (see the first point below). A value that is one user's username and another user's verified email is refused as ambiguous: on a pool that signs in with usernames, anyone can register the username `you@example.com`. Name the account outright with `--username <name>` or `--email <address>` (verified only) in place of `<user>`.
- The group must be one the block declares in `users.groups`; the command refuses any other, and a user the pool does not have. On a deployed stage the groups are read from the stack. Locally they are the groups the local pool holds, which keeps a group dropped from `users.groups` until `.bb-data/` is reset.
- On a deployed stage the command first prints the pool with the AWS account and Region your credentials point at, so a wrong `--profile` shows before you add `--yes`. `--stage sandbox` is this checkout's sandbox and `--stage prod` the production stack (the names `npm run sandbox` and `npm run deploy` give them); `--stack <name>` names any other stack. The pool and its groups are read from the stack itself, so a block with `userPool: Auth.fromExisting(…)` is refused: manage that pool's groups where it is managed.
- With more than one `Auth` block, pick one with `--block <id>` (its id, or its full id when ids overlap, e.g. `auth` and `oidc-auth`).
- `remove-from-group <user> <group>` undoes it, and `list-groups [<user>]` lists the block's groups, or the groups a user is in. Every write to a deployed pool needs `--yes`. Run `npx @aws-blocks/bb-auth users --help` for the rest.

`requireRole` sees the change on the user's next request. Once the first admin exists, have them manage groups through an admin-only method that calls `auth.admin.addUserToGroup` / `removeUserFromGroup` (the [Roles](#roles-and-an-admin-only-user-list) recipe).

**Alternative: from `onSignIn`.** To make the first admin in code instead — for example when no one can run commands against the deployed stage — call `auth.admin.addUserToGroup` from `onSignIn` for an allowlisted email, and check that the pool has **verified** that address:

- `user.attributes.email` is not proof that the user owns the address. A signed-in user can change their own email (`updateUserAttributes`), and a pool this block creates does not turn on Cognito's verification-before-update, so the new address applies at once, unverified (`email_verified: false` until the user confirms the code). `user.attributes` does not carry `email_verified`, so read the pool's record with `auth.admin.getUser` (or, for the signed-in user, `getUserAttributes`) and require `email_verified === 'true'`. The same holds for `phone_number`.
- A federated user's email is the identity provider's claim, not a verification by this pool: leave federated users out, or trust only a provider whose claims you control.
- With `userPool: Auth.fromExisting(…)`, check that the app client's `WriteAttributes` does not include `email_verified` (Cognito allows it): a user who can write the flag can mark any address verified. The client of a pool this block creates sets no `WriteAttributes`, and Cognito's default write set leaves both verified flags out, so its users cannot write them (`NotAuthorizedException`, locally too).

```ts
// aws-blocks/index.ts
import { Auth, Scope } from '@aws-blocks/blocks';

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

The hook works the same locally and deployed, and `requireRole` sees the new group on the user's next request. Once the first admin exists, have them manage groups through an admin-only method that calls `auth.admin.addUserToGroup` / `removeUserFromGroup`, and empty the allowlist: unlike the command, the allowlist stays in the code after it has done its job.

### Social sign-in: the client secret and the callback URL

A provider secret is an `AppSetting` with `secret: true`, never a string. Create the SecureString yourself and reference it, so you set its value:

```ts
// aws-blocks/index.ts
import { AppSetting, Auth, Scope } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const googleSecret = AppSetting.fromExisting(scope, 'google-secret', {
  name: '/my-app/google-client-secret',
  secret: true,
});

const auth = new Auth(scope, 'auth', {
  socialProviders: {
    google: { clientId: 'your-client-id.apps.googleusercontent.com', clientSecret: googleSecret },
  },
  hostedUi: { domainPrefix: 'my-app-auth' }, // fixes the callback URL before the first deploy
});
export const authApi = auth.createApi();
```

1. **Set the secret value** before the first deploy, in the account and Region you deploy to: `aws ssm put-parameter --name /my-app/google-client-secret --type SecureString --value '<client secret>'`. To rotate it, run the same command with `--overwrite` and deploy again: each deploy re-registers the provider with the current value. (`npm run secret` writes AWS Secrets Manager, which `Auth` does not read.) With `new AppSetting(scope, 'google-secret', { secret: true })` instead, the deploy creates the parameter, at `/<fullId>`, with a random value you then overwrite the same way.
2. **Register the callback URL** with the provider. Google calls it an *authorized redirect URI*: `https://my-app-auth.auth.<region>.amazoncognito.com/oauth2/idpresponse` (`/saml2/idpresponse` for SAML). Without `hostedUi.domainPrefix` the prefix is derived from the block's `fullId`; read it from the `UserPoolDomain` resource in the synthesized template. `hostedUi.domainPrefix` is create-only: choose it before the first deploy.
3. **Test on a sandbox** (`npm run sandbox`). Locally the Google button answers `501`, because Cognito managed login needs a deployed user pool.

### End-to-end tests: emailed codes and two users at once

Against the local pool (`npm run dev`), a test reads the code a user was "sent" with `getLastAuthCode`, and acts as several users at once with `createTestClient`, which gives each user the app's typed clients with their own cookie jar. Both come from `@aws-blocks/blocks/utils` (`getLastAuthCode` also from `@aws-blocks/bb-auth/testing`), are Node-only, and belong in test code:

```ts
// aws-blocks/index.ts
import { ApiNamespace, Auth, KVStore, Scope } from '@aws-blocks/blocks';

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
import { createTestClient, getLastAuthCode } from '@aws-blocks/blocks/utils';

const app = await import('aws-blocks');

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

- `getLastAuthCode(username, { block?, purpose?, cwd? })` takes the name the user signs in with (their email on an email sign-in pool). It finds the block's local data under `.bb-data/` itself, so renaming the scope or the block does not break it, and it reads the codes the pool still holds, so a user's code stays readable after another user's was sent. It throws, naming what each local block last sent, when there is no such code, and says so when there is no local pool at all: against a deployed backend Cognito emails the code.
- Run the test from the directory the dev server runs in (the project root), under `tsx -C browser` so `import('aws-blocks')` is the generated client, as the scaffolded `npm run test:e2e` does.
- `createTestClient(app)` returns the clients typed as passed. One user's clients share a jar, so a session `authApi` starts is sent by `api` too; the shared jar `installCookieJar()` installs is never involved.

## Which option and why

Every sign-in method is a key on the same options object, and you can combine them in one block. They differ in what they cost, where they run, and which `Auth` features their users get:

| Option | Configure with | What it's for | Cognito pricing | Works offline in `npm run dev` | Cognito groups / `auth.admin` | MFA | PKCE-only IdPs |
|---|---|---|---|---|---|---|---|
| **Email + password** | `emailPassword` (on by default) | Your own user directory: sign-up with an emailed code, password reset, passkeys | 10,000 free MAUs (none on `'plus'`), then the user pool's feature-plan rate | Yes — a local user pool in `.bb-data/` | Yes | Yes — Cognito MFA through `mfa` (TOTP or SMS; email MFA once `email` sends through SES) | — |
| **Social** | `socialProviders` (`google`, `apple`, `facebook`, `amazon`) | Consumer "Sign in with Google / Apple / Facebook / Amazon" | Same free tier and rate as email + password | No — sign-in answers an actionable `501` locally; deploy a sandbox to test it | Yes — the user becomes a user-pool user | The provider's — Cognito never challenges a federated user | — |
| **Generic OIDC, `federateVia: 'direct'`** (the default) | `oidcProviders` (plus `github()`, `customOauth2()`, `stubIdp()`) | Okta, Entra ID, Auth0, GitHub or any other OIDC / OAuth 2.0 provider, verified by your own backend | No Cognito charge — these users never touch Cognito | Yes — with `stubIdp()`, a real OIDC provider served by the dev server | No pool record: `requireRole()` reads groups from the provider's `groupsClaim`; `auth.admin` does not apply | The provider's | Yes — omit `clientSecret` |
| **Generic OIDC, `federateVia: 'cognito'`** | `oidcProviders` entry with `federateVia: 'cognito'` | The same providers, when you need their users in your Cognito user pool | Separate federated meter: 50 free MAUs, then $0.015 per MAU on every feature plan | No — `501` locally, like social | Yes — the user becomes a user-pool user | The provider's — Cognito never challenges a federated user | No — Cognito requires a client secret |
| **SAML** | `samlProviders` | Enterprise IdPs that only speak SAML 2.0 | Same separate meter as `federateVia: 'cognito'`: 50 free MAUs, then $0.015 per MAU | No — `501` locally, like social | Yes — the user becomes a user-pool user | The provider's — Cognito never challenges a federated user | — (SAML has no PKCE) |

MAU = monthly active user. Prices are from [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/) as read on 4 October 2026; check it before you ship. The feature-plan rate depends on `featurePlan`: `'essentials'` (the default) is $0.015 per MAU above the 10,000-MAU free tier, `'lite'` is $0.0055 but cannot run passkeys, passwordless sign-in or email MFA, and `'plus'` is $0.020 per MAU with no free tier. Users who sign in through SAML or OIDC federation are metered separately on every plan, Plus included: 50 free MAUs, then $0.015 per MAU. Every option also stores sessions in the block's DynamoDB table. A configuration whose only sign-in methods are `federateVia: 'direct'` providers creates no Cognito resources at all.

**How to choose.** Start with email + password: it is the default, needs no identity-provider account, runs fully offline, and is the only option where `Auth` itself enforces MFA and passkeys. Add `socialProviders` for consumer sign-in — those users cost the same as password users, but their sign-in only works on a deployed stack. For a workforce IdP or any other OIDC provider, keep the default `federateVia: 'direct'`: there is no Cognito charge, `stubIdp()` lets you test offline, and public PKCE-only clients work. Switch a provider to `federateVia: 'cognito'` only when you need its users in your user pool — Cognito groups, `auth.admin` or Cognito-issued tokens for them — and accept the 50-free-MAU meter and the client-secret requirement; it adds no MFA, device tracking or adaptive authentication, because Cognito leaves all authentication of federated users to their IdP. Use `samlProviders` only for an IdP that does not speak OIDC. If a frontend may later sign in with the Amplify client libraries against the same pool, read [Planning to use Amplify client libraries?](#planning-to-use-amplify-client-libraries) before the first deploy: some of those choices are permanent.

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
- `auth.protect(...)` defines an API namespace that is deny by default: its `methods` run only after the session check (and the group check, with `role`), and only its `public` methods are callable without a session ([Protect every method](#protect-every-method)).
- **Locally** (`npm run dev`, tests), email + password works end to end with no AWS account: sign-up with an emailed code, sign-in and its challenges, password reset, MFA (TOTP / SMS / email), devices, user attributes, `deleteUser`, passkeys, and the opt-in `auth.admin` surface. The local user pool lives in `.bb-data/<fullId>/state.json` — the same file `AuthCognito`'s mock writes, so local users survive the switch.
- On AWS, email + password runs against Amazon Cognito: sign-up and confirmation (with automatic sign-in after the emailed code), sign-in with every challenge `AuthCognito` supports (MFA, new-password-required, `USER_AUTH` choice-based and passwordless sign-in, passkey sign-in), password reset and change, token refresh, live group reads for `requireRole`, global sign-out and passkey management, user attributes, `deleteUser`, authenticator-app (TOTP) setup and MFA preferences, devices, and the opt-in `auth.admin` surface. `rememberDevice` throws a `501` on AWS, as it did in `AuthCognito` ([why](./DESIGN.md#known-gaps-documented-not-built)).
- Directly federated sign-in works, locally and deployed: any `oidcProviders` entry (OIDC discovery, PKCE, JWKS-verified ID tokens; public PKCE-only clients included), bare OAuth 2.0 through `github()` / `customOauth2()`, and the local stub IdP (`stubIdp()`), which gives `emailPassword: false` apps an offline sign-in.
- On AWS, social, SAML and `federateVia: 'cognito'` providers sign in through Cognito managed login: the sign-in button goes straight to the provider (PKCE, Cognito-issued tokens verified against your user pool), and the user becomes an ordinary user-pool user — `requireRole()` reads their Cognito groups and `auth.admin` manages them like email + password users. Sign-out also ends the managed-login session, so the next sign-in asks the provider again. MFA for these users is the provider's: Cognito never challenges a federated user, so enforce MFA at your IdP. Locally (`npm run dev`) these providers answer sign-in with an actionable `501` — managed login needs a deployed user pool; use a direct provider or `stubIdp()` for offline sign-in.
- Native and CLI clients can authenticate with `Authorization: Bearer <access token>` when `allowBearerAuth: true`, as with `AuthOIDC`: the guards accept a directly federated provider's access token (the one `/aws-blocks/auth/exchange` returns and `/aws-blocks/auth/exchange/refresh` renews) or a user-pool user's Cognito access token. With `allowBearerAuth: { clientIds }`, access tokens from other app clients of the same pool are accepted too — for a frontend that signs in with an Amplify client library ([below](#planning-to-use-amplify-client-libraries)). The session cookie wins when both are sent, and a bearer token stays valid after `signOut()` until it expires. See [DESIGN.md](./DESIGN.md#bearer-tokens-allowbearerauth-d6c--bearerts).
- The CDK layer provisions the same resources as `AuthCognito` (same construct ids, so an `AuthCognito` app that switches keeps its user pool and sessions), creates no Cognito resources for a direct-OIDC-only configuration, and follows the stack's `removalPolicy` / `deletionProtection` defaults. For social, SAML and `federateVia: 'cognito'` providers it also provisions a Cognito domain, a separate hosted-UI app client and one identity-provider registration per provider (provider secrets stay in SSM and never enter the template); see `DESIGN.md` → *Hosted-UI federation* and *The hosted-UI engine*.
- The CDK layer refuses user-pool changes Cognito cannot apply to an existing pool (sign-in attributes, username case sensitivity, required attributes, changing or removing a custom attribute): at synth, against a baseline file it writes to `aws-blocks/baselines/` (commit that file), and again at deploy, before the pool is updated. The synth check also refuses a change that would remove the pool — including renaming or deleting the `Auth` block, which would make CloudFormation delete the pool and every user in it ([details](./DESIGN.md#renaming-or-removing-an-auth-block)) — once a committed baseline records the pool. A block's first synth has nothing to compare against: if it records no pool, synth only warns. Moving from `AuthCognito`? Deploy the codemod's output unchanged first ([MIGRATION.md](./MIGRATION.md#before-every-deploy-the-checklist)). Re-baseline deliberately with `BLOCKS_AUTH_REBASELINE=<block fullId>`. The baseline advances when you synthesize, not when you deploy, so reverting a change you synthesized but never deployed is refused too; the error then gives the re-baseline command for that case. See [DESIGN.md](./DESIGN.md#immutability-guard-q5).

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

The stub runs in `npm run dev` and on sandbox deployments (`npm run sandbox`) only. Synthesizing any other deployment with a `stubIdp()` provider fails, so a backend module that is also deployed to production must choose its provider by deployment type. `getDeploymentType()` reports the same value at synth and in the deployed Lambda (`'local'`, `'sandbox'` or `'production'`), so both make the same choice.

**The stub in local dev and sandbox, the real provider in production.** Keep one provider id and pick its entry from `getDeploymentType()`. The client code (`signIn:corp`) is the same everywhere:

```typescript
// aws-blocks/index.ts
import { Auth, getDeploymentType, stubIdp } from '@aws-blocks/blocks';

const auth = new Auth(scope, 'auth', {
  emailPassword: false,
  oidcProviders: {
    corp:
      getDeploymentType() === 'production'
        ? { issuer: 'https://login.example.com', clientId: 'my-client-id' }
        : stubIdp({ users: [{ sub: 'u-1', email: 'alice@example.com', name: 'Alice' }] }),
  },
});
```

You may not need the stub at all: email + password already runs offline, and a direct OIDC provider works in `npm run dev` too if you register `http://localhost:<port>/aws-blocks/auth/callback` as a redirect URI with it.

**The stub on a sandbox.** A sandbox serves the stub from the deployed backend, so an end-to-end test needs no external IdP. The stub signs users in without credentials: **anyone who can reach the sandbox can sign in as any of the stub's users**, with their claims and groups. Synth succeeds with a `@aws-blocks/bb-auth:StubIdpDeployed` warning. Deployed, the stub's issuer is the API Gateway URL (`https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/aws-blocks/auth/idp/<id>`) and its signing keys are derived from the block's session secret, so every Lambda instance serves the same keys. The Lambda serves the stub only when its deployed config says the deployment is a sandbox; after upgrading, restart `npm run sandbox` once, because a `cdk watch` hotswap alone does not write that config.

A directly federated user's `userId` is `` `${issuer}:${sub}` `` (the same as `AuthOIDC`), and `requireRole()` reads their groups from the provider's `groupsClaim`. Register `<your origin>/aws-blocks/auth/callback` as the redirect URI with the IdP, and `<your origin>/` (or `<your origin><redirects.postSignOutPath>`) as the post-logout redirect URI when the IdP supports sign-out.

For a provider federated through Cognito (social, SAML, `federateVia: 'cognito'`) the CDK layer registers the callback and sign-out URLs on the Cognito app client for you; in the IdP's console, register the Cognito domain's `https://<domain>/oauth2/idpresponse` (`/saml2/idpresponse` for SAML) instead.

Provider secrets are `AppSetting` references created with `secret: true` (at the default name, with an explicit `name`, or via `AppSetting.fromExisting`), never strings. The RPC surface stays the two methods the sign-in UI uses (`getAuthState` / `setAuthState`), via `auth.createApi()`. Its `setAuthState` input is typed by the block's options (`AuthActionInputOf<O>`), so a frontend call to an action the options turn off, such as `signIn` on `emailPassword: false`, is a compile error.

The option groups and the method surface are documented in the JSDoc of the exported `AuthOptions` and `AuthShape` types.

## Sign-up and email delivery

Every self-service sign-up confirms the email address with an emailed code. With `emailPassword.autoSignIn` (on by default), the user is then signed in without typing their password again — the code itself is still required.

Cognito's default email sender is limited to 50 emails per day (confirmation, password-reset and email-MFA codes all count). That is enough for development, not for production. Before launch, send through your own Amazon SES identity with `email`:

```ts
import { Auth } from '@aws-blocks/bb-auth';

const auth = new Auth(scope, 'auth', {
  email: { fromAddress: 'no-reply@example.com', fromName: 'Example App' },
});
```

- **Verify the sender in SES first,** in the pool's Region (or set `sesRegion`): the address itself, or its domain with `sesVerifiedDomain: 'example.com'`. A new SES account is in the sandbox and only delivers to verified recipients, so request SES production access before real users sign up. The same verified address can serve an `EmailClient` (its `fromAddress`).
- **Optional:** `replyTo`, and `configurationSetName` for SES event publishing or a dedicated IP pool.
- **It also unlocks the email factors:** email MFA (`mfa: { types: ['EMAIL', …] }`) and `users.preferredChallenge: 'EMAIL_OTP'` need an SES sender, and synth refuses them on a pool this block creates without one.
- **Safe to add later:** it updates the pool in place, and no user, session or token is affected. On that first deploy Cognito creates its email service-linked role, so the deploying role needs `iam:CreateServiceLinkedRole` (CDK's default deployment role has it).
- Only for a pool this block creates. With `userPool: Auth.fromExisting(…)`, configure SES on that pool yourself.
- Locally (`npm run dev`) nothing changes: codes are delivered as before (`codeDelivery`), without SES.

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
- When the options set `mfa` to anything but `'optional'` / `'required'` (or omit it), the MFA methods (`setUpTotp`, `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`) are compile errors (`ERROR_mfa_is_off_on_this_Auth_instance`); when they configure no `passkeys` options object, so are the passkey methods (`ERROR_passkeys_are_not_enabled_on_this_Auth_instance`). With `mfa.types` listed inline, `updateMfaPreference` rejects a factor it leaves out (`ERROR_SMS_is_not_in_mfa_types`, and the same for `TOTP` / `EMAIL`).
- `auth.admin` is unusable unless the options include `admin: {}`: its methods are compile errors (`ERROR_admin_is_not_enabled__construct_Auth_with_admin_options`). With `admin: { actions: ['groups'] }`, the lifecycle methods are compile errors (`ERROR_admin_action_not_granted`), and vice versa.
- `signIn`, `confirmSignIn` and `autoSignIn` return only the `nextStep` values the configuration can produce, so a `switch` on `nextStep.name` handles just those: the MFA steps need `mfa` on (and each factor's steps that factor in `mfa.types`), `CONFIRM_SIGN_IN_WITH_WEB_AUTHN` needs `passkeys`, and the first-factor steps need `users.authFlow: 'USER_AUTH'`. With `userPool: Auth.fromExisting(…)` every step stays, since the wrapped pool's own settings decide them. The full list is in `SignInNextStep`'s documentation.
- The sign-in UI's `authApi = auth.createApi()` takes only the actions the configuration allows (`AuthActionInputOf<O>`), in the frontend too: `authApi.setAuthState({ action: 'signIn', … })` and `submitAuthAction(authApi, { action: 'signIn', … })` are compile errors with `emailPassword: false`, the passkey actions need `passkeys`, and `confirmSignIn` takes only the challenges that answer the steps above (`mfaType` one of `mfa.types`).
- A narrowly configured instance is still assignable to the plain `Auth` type, so helpers typed `(auth: Auth)` keep working. On the plain type, federation and `auth.admin` are closed (type such a helper with the instance's own type, `typeof auth`), while the email + password, MFA and passkey methods stay callable and are checked at runtime. That includes `new Auth(scope, 'auth')` with no options, which the compiler cannot tell apart from the plain type.

The gates are TypeScript-only. What the OpenRPC spec gives a native client (Swift, Kotlin, Dart):

- The types the mode options narrow, in their wide form whatever the options, so differently configured blocks generate the same native type: `setAuthState`'s input (every action and `confirmSignIn` challenge) and its `AuthState`, a sign-in result's `nextStep` (every step), and `getMfaPreference` / `updateMfaPreference` (every factor).
- The signed-in user (`AuthenticatedUser`, from `requireAuth`, `getCurrentUser` or a sign-in result your API returns) with its block's own schema: `signInProvider` lists that block's provider ids and `groups` its declared groups. Blocks whose users have the same schema share one `AuthenticatedUser` type; a user whose schema differs (other providers, declared groups) is described where it is used, so a native client never decodes it with another block's type.

The server enforces each block's configuration, whatever the caller's language: an action or factor it does not offer is answered with an error (for `setAuthState`, an error state such as `EmailPasswordNotEnabledException`). A passkey action or the `webauthn` challenge without `passkeys` answers `PasskeysNotEnabledException`; an MFA method or challenge with MFA off answers `MfaNotEnabledException` (both 409); a factor outside `mfa.types`, or a `USER_AUTH` challenge without `users.authFlow: 'USER_AUTH'`, answers `InvalidParameterException` naming the option. A sign-in step the options do not enable is an `InternalErrorException` naming it.

The cause is not on the first line of the error. A gated call is an arity error, and the gate's name is in the related-information line (`auth.signIn('alice', 'pw', context)` with `emailPassword: false`):

```
TS2554: Expected 4 arguments, but got 3.
  Arguments for the rest parameter 'ERROR_emailPassword_is_disabled_on_this_Auth_instance' were not provided.
```

Editors and `tsc --pretty` show both lines; plain `tsc` output (as in CI logs) shows only the first. Ignore the "add an argument" suggestion: hover the method, and its last parameter names the option the call needs. Each gate reads the same way, with its own `ERROR_` name.

Pass options inline, or keep them in a variable declared `as const satisfies AuthOptions`. Plain `satisfies AuthOptions` keeps the gates but widens arrays: with `users: { groups: ['admins', 'readers'] }`, `user.groups` becomes `string[]` and `requireRole` accepts any string, with no error anywhere. A variable annotated `: AuthOptions` loses every narrowing.

```typescript
import { Auth, type AuthOptions } from '@aws-blocks/bb-auth';

const options = {
  emailPassword: false,
  oidcProviders: { corp: { issuer: 'https://login.example.com', clientId: 'my-client-id' } },
  users: { groups: ['admins', 'readers'] },
} as const satisfies AuthOptions;
const auth = new Auth(scope, 'auth', options);
// user.groups: ('admins' | 'readers')[]
```

`mfa` (other than `'off'`), `passkeys` and `users.deviceTracking` apply only to email + password users, so combining any of them with `emailPassword: false` is an error at construction (in `npm run dev`, at synth and in Lambda) that names both options; federated users get MFA and passkeys from their identity provider.

An option `Auth` does not recognise is an error at construction, in `npm run dev`, at synth and in Lambda alike, so a misspelled or misplaced setting can't be silently ignored. The error names each unknown option's path with a suggestion (`` `preferredChallenge`: it is not an option here; did you mean `users.preferredChallenge`? ``). The compiler alone doesn't catch these: TypeScript does no excess-property check on the inferred options type ([why](./DESIGN.md#unknown-options-d1b)). A boolean option must be `true` or `false` (or left out): a value such as `selfSignUp: 0` or `passkeys: 'false'` from untyped code is an error too, rather than turning the setting on or off by accident.

## Local development

Locally, no email or SMS is sent. Every verification code (sign-up, password reset, MFA, attribute verification) is written to `.bb-data/<fullId>/last-code.json` as `{ username, code, purpose }`, and is passed to the optional, local-only `codeDelivery` hook. In a test, read it with `getLastAuthCode(username)` rather than the file: the path follows the scope and block names ([recipe](#end-to-end-tests-emailed-codes-and-two-users-at-once)):

```typescript
const auth = new Auth(scope, 'auth', {
  codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
});
```

The AWS runtime ignores `codeDelivery`: Cognito delivers the codes. ⚠️ Local passwords are stored in plain text in `.bb-data/` (git-ignored) — never point the local runtime at real credentials. The local pool also accepts any 6-digit authenticator-app code and does not verify passkey signatures; see the mock-vs-AWS table in [DESIGN.md](./DESIGN.md#mock-vs-aws-behaviour-differences).

## Sign-in UI

`@aws-blocks/bb-auth/ui` re-exports the shared sign-in UI from `@aws-blocks/auth-common/ui` (`Authenticator`, `AccountMenuBar`, `AuthenticatedContent`, `onAuthChange`, `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`) and adds `authOverrides()`, which type-checks `Authenticator` options against `Auth`'s action, next-step and field names. Federated providers appear as `signIn:<id>` actions that carry a `url`, so the `Authenticator` renders them as plain "Sign in with …" buttons and the RPC surface stays `getAuthState` / `setAuthState`.

`signIn:<id>` is a URL action, not an RPC action, because federated sign-in is a browser redirect. The browser has to navigate to the identity provider, and come back to `/aws-blocks/auth/callback` carrying the pending-auth cookie the `signin/<id>` route set, so a JSON-RPC call cannot perform it. That is why `setAuthState` does not accept it (the server answers `{ action: 'signIn:<id>' }` with an `InvalidParameterException` state): follow the action's `url` instead. Its typed names are `FederatedActionNameOf<O>`, `` `signIn:${id}` `` for each configured provider id:

```typescript
// aws-blocks/index.ts — the backend
import { Auth, type AuthOptions, type FederatedActionNameOf, Scope } from '@aws-blocks/blocks';

const scope = new Scope('app');
const authOptions = {
  emailPassword: false,
  oidcProviders: { okta: { issuer: 'https://dev-12345.okta.com', clientId: 'my-client-id' } },
} as const satisfies AuthOptions;
const auth = new Auth(scope, 'auth', authOptions);

export const authApi = auth.createApi();
/** The `signIn:<id>` action names, for the frontend. */
export type ProviderAction = FederatedActionNameOf<typeof authOptions>;
```

```typescript
// src/main.ts — the browser
import { authApi, type ProviderAction } from 'aws-blocks';

const okta: ProviderAction = 'signIn:okta'; // 'signIn:otka' is a compile error
const state = await authApi.getAuthState();
const action = state.actions.find((a) => a.name === okta);
if (action?.url) window.location.assign(action.url);
```

`AuthState.user` is typed by the block's options too (`AuthStateUser<O>`: the signed-in `AuthenticatedUser` without the server-only `claims` and `federatedIdentity`), and so is the user every UI helper hands you, so the frontend reads roles and attributes without an extra endpoint. `AuthUserOf<typeof authApi>` names the type:

```typescript
// src/main.ts — the browser
import { onAuthChange } from '@aws-blocks/blocks/ui';
import { authApi } from 'aws-blocks';

onAuthChange(authApi, (user) => {
  // With users: { groups: ['admins', 'readers'] }: user.groups is ('admins' | 'readers')[]
  document.body.classList.toggle('admin', user?.groups.includes('admins') ?? false);
});
```

```typescript
import { Authenticator, authOverrides } from '@aws-blocks/bb-auth/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi, authOverrides({
  hideActions: ['signUp'],
  actions: { signIn: { fields: { username: { label: 'Email', autocomplete: 'email' } } } },
})));
```

### Render the login UI and gate the app

Exporting `authApi` provisions the backend, but **it does not render a login screen**: the SPA shows nothing until you mount an auth component, and every authenticated route stays unreachable. Mount the UI in the SPA entrypoint and gate the app shell behind a session:

```typescript
// src/index.ts — the SPA entrypoint
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, AuthenticatedContent } from '@aws-blocks/blocks/ui';

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

- `AccountMenuBar(authApi)` renders the entry point that opens the `Authenticator`. To embed the form inline instead, use `Authenticator(authApi)` directly.
- `AuthenticatedContent(authApi, render, fallback)` subscribes to the session and swaps between `render(user)` and `fallback` on sign-in and sign-out; that's what gates the shell.
- The fields and buttons carry stable test ids an e2e suite can target: `authenticator-username` (labelled Email on an email sign-in pool), `authenticator-password`, `authenticator-code`, and `authenticator-action-signUp` / `authenticator-action-signIn`. Don't fork the component to add your own.

The scaffolded `default` template's `src/index.ts` is a complete working app built on this seam.

To restyle, replace or drive the forms yourself, and for the `data-testid` contract e2e suites rely on, see [Customizing Auth UI](./CUSTOMIZING-AUTH-UI.md).

## Frontend on a different origin

When the frontend and the API share an origin (`Hosting`'s default), the `Authenticator`'s "Sign in with …" links are all you need. When the frontend is served from another origin, for example `https://app.example.com` calling `https://api.example.com`, use the browser redirect client from `@aws-blocks/bb-auth/browser-client` (also exported from `@aws-blocks/blocks/ui`). It signs in with a federated provider through the block's own routes, then reads and ends the session:

```typescript
import { createAuthClient } from '@aws-blocks/bb-auth/browser-client';

const auth = createAuthClient<'okta'>({
  baseUrl: 'https://api.example.com',            // where /aws-blocks/auth/* is served
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
  oidcProviders: { okta: { issuer: 'https://dev-1.okta.com', clientId: '0oa1' } },
  redirects: { allowedRelayOrigins: [relayOrigin('https://app.example.com')] }, // where sign-in may return
  session: { crossDomain: true }, // only when the two are on different registrable domains
});
// …and the frontend origin in the stack's CORS allowlist: `defaults.allowedOrigins` (see the core README).
```

- **What it does.** `signInWithRedirect()` gets a signed `state` from the block, bound to a fresh CSRF value and to `redirectUri`, then sends the browser to the provider with PKCE. The provider returns to the block's callback, which re-checks `redirectUri` against `allowedRelayOrigins` and forwards only the one-time code. `handleSignInRedirect()` checks the response belongs to the sign-in this tab started and exchanges the code; the session is the block's usual `HttpOnly` cookie. No token is ever stored in JavaScript or put in a URL. The provider's `redirect_uri` is `<baseUrl><callbackPath>`, so `baseUrl` must be the origin your providers have registered (for providers federated through Cognito, the app origin the block registers on its managed-login client).
- **Local development.** A frontend at `http://127.0.0.1:<port>` is always allowed, and the dev server's CORS already admits it. Open both the frontend and the dev server at `127.0.0.1` (not `localhost`), so they are the same site and the session cookie needs no `crossDomain`.
- **Which providers.** Every provider that signs in by redirect: `oidcProviders` (including `stubIdp()` locally), `socialProviders` and `samlProviders`. Email and password sign-in keeps using `authApi` (`getAuthState` / `setAuthState`), which works across origins with the same CORS and cookie settings.
- **Sign-out.** `signOut()` ends the block's session. When the provider keeps its own session (Cognito managed login, or an OIDC provider with an `end_session_endpoint`), it also returns `logoutUrl`; `endProviderSession: true` navigates there. The provider then returns the browser to `redirects.postSignOutPath` on the API's origin.
- **Names.** The methods follow Amplify JS v6 (`signInWithRedirect`, `fetchAuthSession`, `getCurrentUser`, `signOut`); the user and the errors are the block's own (`isAuthError(e, AuthErrors.InvalidRelay)`, …). Note that `user.userId` is the block's id; Amplify's `getCurrentUser().userId` is the Cognito `sub`, which is `user.userSub` here.

## Planning to use Amplify client libraries?

`Auth` signs users in on your backend: the browser talks to your API, and the session lives in an `HttpOnly` cookie. The Amplify client libraries (JavaScript, Swift, Android, Flutter) do the opposite: the app signs in directly against Amazon Cognito and holds the tokens itself. Both can share one user pool, so you can start with `Auth` and add an Amplify frontend later. A few choices decide whether that stays possible, and some of them are permanent:

- **Choose the pool's shape before real users sign up.** Cognito fixes how users sign in and whether names match case-sensitively when the pool is created; the block refuses a later change. Amplify Gen 2 pools sign in with the email address, matched ignoring case. Use the same shape (the `create-blocks-app` templates do):

  ```typescript
  const auth = new Auth(scope, 'auth', {
    users: { signInWith: ['email'], caseSensitive: false },
  });
  ```

  Unset, `users.signInWith` is `['username', 'email']` and `users.caseSensitive` is Cognito's default, case-sensitive — the shape `AuthCognito` created, kept so existing pools are untouched.
- **Federate OIDC providers through Cognito if Amplify clients will sign in with them.** Amplify signs users in only through Cognito. A provider with `federateVia: 'direct'` (the default) creates no Cognito user, so moving it to `federateVia: 'cognito'` later gives each of its users a new `userSub`. Pick `'cognito'` from the start, or key your data on `user.federatedIdentity` (`{ providerId, sub }`), which is the same under both. On bearer requests from an extra client, `federatedIdentity` is filled only on an email or phone pool (as the templates create); on a username pool a password user could choose a `Google_…` username, so it's left out there.
- **Share `userSub`, not `userId`.** For a user-pool user, `user.userSub` is the Cognito `sub` — what Amplify's `getCurrentUser()` returns as `userId`. This block's `userId` is the Cognito username (Amplify's `username`).
- **Give the Amplify app its own app client, and accept its tokens.** Don't widen the block's own `client`: Amplify's default sign-in flow (SRP) is off on it by design. Give the Amplify app its own public client and list it in `allowBearerAuth.clientIds`, so the guards accept the **access** tokens it sends as `Authorization: Bearer`. (ID tokens are never accepted. With Amplify JS, send `(await fetchAuthSession()).tokens?.accessToken.toString()`.)

  A `clientIds` entry can be a literal id or a CDK token: the block forwards the list through its deployed config, so a token resolves at deploy time.

  **A pool Amplify Gen 2 created** (or any pool created elsewhere in the same CDK app): wrap it with `Auth.fromExisting` and pass the ids as tokens. The backend module is loaded while the CDK app synthesizes, so hand them over before creating the Blocks backend:

  ```typescript
  // amplify/blocks.ts
  const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
  process.env.AMPLIFY_USER_POOL_ID = cfnUserPool.ref;        // CDK tokens, read at synth
  process.env.AMPLIFY_USER_POOL_CLIENT_ID = cfnUserPoolClient.ref;
  const blocks = await createBlocksBackend(blocksStack, sandboxMode);
  ```

  ```typescript
  // aws-blocks/index.ts
  const auth = new Auth(scope, 'auth', {
    // At synth these are tokens; in the Lambda they're unset, and the block reads
    // the deployed pool and client ids from its own config.
    userPool: Auth.fromExisting(process.env.AMPLIFY_USER_POOL_ID ?? '', process.env.AMPLIFY_USER_POOL_CLIENT_ID),
    allowBearerAuth: true, // fromExisting's client id is accepted
  });
  ```

  A Gen 2 pool is deleted with its stack by default, so retain it before you hand it over.

  **A client of the block's own pool** is created after the block, so its id can't be passed to the constructor as a token. Add it in `aws-blocks/index.cdk.ts`, then list the id the first deploy printed:

  ```typescript
  // aws-blocks/index.cdk.ts — after `const blocksStack = await BlocksStack.create(...)`
  import * as cdk from 'aws-cdk-lib';
  import * as cognito from 'aws-cdk-lib/aws-cognito';

  const pool = blocksStack.node.findChild('my-app').node.findChild('auth').node.findChild('pool');
  if (!(pool instanceof cognito.UserPool)) throw new Error('expected the Auth user pool');
  const web = pool.addClient('amplify-web', { generateSecret: false, authFlows: { userSrp: true } });
  new cdk.CfnOutput(blocksStack, 'AmplifyWebClientId', { value: web.userPoolClientId });
  ```

  ```typescript
  // aws-blocks/index.ts
  const auth = new Auth(scope, 'auth', {
    users: { signInWith: ['email'], caseSensitive: false },
    allowBearerAuth: { clientIds: ['<AmplifyWebClientId from the stack output>'] },
  });
  ```
- **Hooks run on the backend's sign-in path only.** `validateUser`'s `phase: 'signUp'` check also covers a sign-up sent straight to Cognito, through the pool's PreSignUp trigger. `phase: 'signIn'`, `onSignIn` and `onSignOut` run only for sign-ins and sign-outs that go through this block; an Amplify app that signs in directly is not seen. Gate each request with `requireAuth` / `requireRole`, which accept its bearer tokens.

## Migrating from `AuthBasic`, `AuthCognito` or `AuthOIDC`

See [MIGRATION.md](./MIGRATION.md): per-block before → after code, what happens to deployed pools, users and sessions, and the codemod (`npx @aws-blocks/bb-auth migrate --dry-run`). The one rule: never change the block's id argument.

## Design

See [DESIGN.md](./DESIGN.md).
