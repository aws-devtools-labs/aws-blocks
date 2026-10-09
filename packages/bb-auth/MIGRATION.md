# Migrating to `Auth`

`Auth` (`@aws-blocks/bb-auth`) replaces `AuthBasic`, `AuthCognito` and `AuthOIDC`. The three old packages are removed in the same release, with no compatibility layer. This guide covers what changes for each of them, what happens to your deployed resources and signed-in users, and the codemod that does the mechanical part of the work.

> ## ⚠️ The one rule: never change the block's `id` argument
>
> `new AuthCognito(scope, 'auth', …)` becomes `new Auth(scope, 'auth', …)`, with **the same `scope` and the same `'auth'`**. The class name isn't part of any resource name, so swapping it changes nothing in AWS. The id is part of every resource name. Change it, or move the block under another scope, and CloudFormation creates a new Cognito user pool and **deletes the old one along with every user in it**. Sessions, the session table and the session secret are replaced the same way.
>
> The codemod never edits the first two constructor arguments. If an id expression mentions the old class name (for example `AuthCognito.name`), the codemod leaves it unchanged and adds a TODO, because that expression would now evaluate to a different string. Replace it with the string it used to produce.

Snippets in this guide import from `@aws-blocks/bb-auth`. If your app imports Building Blocks from `@aws-blocks/blocks`, import the same names from there instead (`Auth`, `AuthErrors`, `stubIdp`, `github`, `customOauth2`, `relayOrigin` and the option types).

## Contents

- [Run the codemod](#run-the-codemod)
- [What happens on the first deploy](#what-happens-on-the-first-deploy)
- [`AuthCognito`](#authcognito)
- [`AuthOIDC`, direct federation](#authoidc-direct-federation)
- [`AuthOIDC` with `cognitoFederated()`](#authoidc-with-cognitofederated)
- [`AuthBasic`](#authbasic)
- [Before every deploy: the checklist](#before-every-deploy-the-checklist)
- [Option mapping](#option-mapping)
- [Names, methods and types](#names-methods-and-types)
- [Error names](#error-names)
- [What the codemod can't map](#what-the-codemod-cant-map)

## Run the codemod

From your app's root directory:

```bash
npx @aws-blocks/bb-auth migrate --dry-run   # print a unified diff, write nothing
npx @aws-blocks/bb-auth migrate             # rewrite the files
npx @aws-blocks/bb-auth migrate aws-blocks src   # or name the files or directories to migrate
```

The codemod uses your project's own `typescript` package to parse your code. If the project doesn't have one, run `npx -p typescript -p @aws-blocks/bb-auth bb-auth migrate`.

What it does:

- Rewrites imports. `@aws-blocks/bb-auth-basic`, `-cognito` and `-oidc` become `@aws-blocks/bb-auth`, and `@aws-blocks/bb-auth-cognito/ui` becomes `@aws-blocks/bb-auth/ui`, with its names renamed (`cognitoOverrides` → `authOverrides`, …; see [Names](#names-methods-and-types)). Names imported from `@aws-blocks/bb-auth-oidc/client` or `/middleware` that `@aws-blocks/bb-auth` also exports (the provider helpers, `relayOrigin`, the error constants and types) move to `@aws-blocks/bb-auth`; the rest stay, with a TODO. Old names imported from `@aws-blocks/blocks` are renamed, and the import itself keeps pointing at `@aws-blocks/blocks`. So are old names reached through `import * as blocks from '@aws-blocks/blocks'` (`new blocks.AuthCognito(…)` → `new blocks.Auth(…)`). Several old imports that end up on the same module are merged into one.
- Renames the classes, types and error constants, and maps each old options object onto the `Auth` shape (see [Option mapping](#option-mapping)). That includes `AuthOIDC`'s `providers` array, which becomes `oidcProviders` / `socialProviders` records keyed by provider id.
- Renames the methods that changed (`fetch*` → `get*` / `scan*`, `updateUserAttribute` → `updateUserAttributes`, …) on any receiver it can trace to an old block: a local variable, an import of an exported instance, or a parameter typed with the old class.
- Leaves a `// TODO(aws-blocks-auth-migrate): …` comment wherever you have to decide something. That covers every `AuthBasic` block, every `hasAuthError` / `isBlocksError` / `isAuthError` check on an auth error, error names that split, `cognitoFederated()` providers, options it can't see (passed by reference or spread in), and every case in [What the codemod can't map](#what-the-codemod-cant-map).
- Never touches the scope or id argument, and refuses to write a file if a constructor's first two arguments would differ afterwards.
- Writes only files that actually change, and is idempotent: running it again changes nothing. At the end it prints a summary of every file and change.

Comments and formatting are preserved, except where an options object is regrouped. There the codemod re-indents the moved options to match the surrounding style, and the comments move with them.

After it runs:

1. Search for `TODO(aws-blocks-auth-migrate)` and resolve every hit. The TypeScript compiler flags most of the remaining work.
2. Replace `@aws-blocks/bb-auth-basic` / `-cognito` / `-oidc` in `package.json` with `@aws-blocks/bb-auth`. Apps that depend only on `@aws-blocks/blocks` just update it. Then run `npm install`.
3. Typecheck, run your tests and `npm run dev`, then work through [the checklist](#before-every-deploy-the-checklist) before you deploy. Its first item matters most: deploy the codemod's output **unchanged**, commit the baseline it writes, and only then change the configuration.

## What happens on the first deploy

| Switching from | User pool | Session table and secret | Users | Signed-in sessions |
|---|---|---|---|---|
| `AuthCognito`, same id | **Kept**: same construct id `pool`, same `userPoolName` | **Kept**: same `sessions` / `session-secret` | Kept, including passwords, groups and attributes | **Stay valid**: same cookie name, HMAC secret and table |
| `AuthOIDC`, direct (`google()`, `github()`, `customOidc()`, `customOauth2()`, `stubIdp()`) | None is created (direct federation needs no pool); nothing is destroyed | The table is kept. Old rows are treated as signed out. The old `/<fullId>-cookie-secret-<id>` parameter is deleted | The IdP is the source of truth, and `userId` stays `` `${iss}:${sub}` `` | The old `oidc_…` cookie is ignored, so every user signs in once more |
| `AuthOIDC` with `cognitoFederated()` | The old `cognito-pool` is **deleted** and replaced by `pool`. Its domain prefix collides (see below) | As for direct | The pool's shadow users are deleted. **`userId` changes**, so data keyed on it must be [re-keyed](#re-keying-cognitofederated-users) | Every user signs in once more |
| `AuthBasic` | A **new** pool | The `users` / `codes` tables and the `jwt-secret` parameter are **retained under `BlocksPresets.production` and deleted under `BlocksPresets.sandbox`** | **Lost**: every user must sign up again | The `auth_<fullId>` cookie is rejected and cleared (signed out, never an error) |

For `AuthCognito`, "kept" assumes the first `Auth` deploy still has a pool-backed sign-in method and does not wrap the block's own pool: deploy the codemod's output unchanged first ([checklist](#before-every-deploy-the-checklist)).

## `AuthCognito`

Your pool, your users and their sessions survive, **provided the block's id is unchanged**.

```ts
// Before (AuthCognito)
import { AuthCognito, AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito';

const auth = new AuthCognito(scope, 'auth', {
	selfSignUp: true,
	passwordPolicy: { minLength: 12 },
	signInWith: 'email',
	groups: ['admins', 'editors'],
	userAttributes: [{ name: 'tenant' }],
	mfa: 'optional',
	sessionTtlSeconds: 86_400,
	admin: {},
	removalPolicy: 'retain',
});
const attrs = await auth.fetchUserAttributes(context);
```

```ts
// After (Auth)
import { ApiNamespace, Scope } from '@aws-blocks/blocks';
import { Auth, AuthErrors, isAuthError } from '@aws-blocks/bb-auth';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
	emailPassword: { selfSignUp: true, passwordPolicy: { minLength: 12 } },
	users: {
		signInWith: ['email'],
		groups: ['admins', 'editors'],
		attributes: [{ name: 'tenant' }],
	},
	mfa: { mode: 'optional', types: ['SMS'] },
	session: { ttlSeconds: 86_400 },
	admin: {},
	removalPolicy: 'retain',
});

export const authApi = auth.createApi();
export const api = new ApiNamespace(scope, 'api', (context) => ({
	async profile() {
		try {
			return await auth.getUserAttributes(context);
		} catch (e) {
			if (isAuthError(e, AuthErrors.NotAuthenticated)) return null;
			throw e;
		}
	},
}));
```

What changes, and why it matters:

- **`mfa` lists its factors.** With MFA on and no `mfaTypes`, `AuthCognito` enabled SMS only, while `Auth` defaults `types` to `['SMS', 'TOTP']`. The codemod writes `types: ['SMS']` explicitly so the upgrade doesn't quietly turn on authenticator-app MFA. Widen it on purpose if you want TOTP.
- **Deletion policy follows the stack preset.** `AuthCognito`'s pool was `DESTROY` unless you set `removalPolicy: 'retain'`, even under `BlocksPresets.production`. `Auth` follows the stack's defaults (`production` retains, `sandbox` destroys) when `removalPolicy` / `deletionProtection` are unset. A production-preset pool gets one intended change on the first deploy: its `DeletionPolicy` becomes `Retain` and deletion protection turns on. Under the sandbox preset it stays `Delete`, as before. **Set `removalPolicy: 'retain'` explicitly on any pool that holds real users.**
- **Passkeys:** `enablePasskeys: true` + `webAuthnRelyingParty: { id, origins, userVerification }` becomes `passkeys: { relyingPartyId, origins, userVerification }`. `'discouraged'` is no longer accepted. `AuthCognito` silently applied `'preferred'` for it, so the codemod writes `'preferred'` and the deployed behaviour is unchanged.
- **`preferredChallenge`** moves to `users.preferredChallenge`, next to `users.authFlow` (was `authFlowType`). Cognito sends `'EMAIL_OTP'` codes only through Amazon SES, so on a pool the block creates, synth fails for it. A pool you manage (with SES) can be wrapped using `userPool: Auth.fromExisting(…)`, but ⚠️ **never wrap the block's own pool that way**: with `userPool: Auth.fromExisting(<its own pool id>)` the block no longer owns `pool`, so the pool leaves the template and the deploy **deletes it and every user in it** (`AuthCognito`'s pool was `DESTROY` unless you set `removalPolicy: 'retain'`). On the first `Auth` synth nothing refuses this; synth only warns (see [the checklist](#before-every-deploy-the-checklist)). Instead, remove `preferredChallenge` (or pick another first factor) for the first deploy, so users sign in with their password until you move on, deploy, and commit the baseline. To put the users behind an SES-configured pool later, first set `removalPolicy: 'retain'` and deploy, then follow the retain + `cdk import` [runbook in DESIGN.md](./DESIGN.md#runbook-moving-a-user-pool-to-a-new-logical-id-with-cdk-import). Rehearse it in a sandbox stack first. The codemod marks every `'EMAIL_OTP'` with this warning.
- **Sign-up:** `signUp()` no longer takes `autoSignIn`. It is `emailPassword.autoSignIn` (default `true`), and applies when the call carries a context. `confirmSignIn()` takes the answer as a plain string (`{ code }` → `code`). `signIn()` no longer takes `cognitoSession`.
- **Errors:** `AuthCognito`'s 29 error names are unchanged, but some flows now answer differently. Sign-up through the sign-in UI no longer reveals an existing account by default (`emailPassword.revealExistingUsers`), and an unrecognised Cognito error now reaches the client as `InternalErrorException` instead of under its raw name. Review every auth error check (the codemod marks each one).
- **Local data:** the local pool lives in the same `.bb-data/<fullId>/state.json` file, so local users survive.

## `AuthOIDC`, direct federation

Direct providers keep their identity: `userId` is still `` `${iss}:${sub}` ``. Nothing in AWS is destroyed, and no Cognito pool is created. The old session cookie is ignored, so each user signs in once more after the deploy.

```ts
// Before (AuthOIDC)
import { AuthOIDC, google, github, customOidc, relayOrigin, stubIdp } from '@aws-blocks/bb-auth-oidc';

const auth = new AuthOIDC(scope, 'auth', {
	providers: [
		google({ clientId: 'google-client-id', clientSecret: () => googleSecret.get() }),
		github({ clientId: 'github-client-id', clientSecret: () => githubSecret.get() }),
		customOidc({ name: 'okta', issuerUrl: 'https://dev-123.okta.com', clientId: 'okta-id', clientSecret: () => oktaSecret.get() }),
		stubIdp({ name: 'corp' }),
	],
	postSignInPath: '/home',
	allowedRelayOrigins: [relayOrigin('myapp://auth')],
	allowBearerAuth: true,
	onSignIn: async (user) => { await profiles.put(user.userId, { email: user.email }); },
});
```

```ts
// After (Auth)
import { AppSetting, KVStore, Scope } from '@aws-blocks/blocks';
import { Auth, github, relayOrigin, stubIdp } from '@aws-blocks/bb-auth';

const scope = new Scope('my-app');
const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });
const githubSecret = new AppSetting(scope, 'github-secret', { secret: true });
const oktaSecret = new AppSetting(scope, 'okta-secret', { secret: true });
const profiles = new KVStore<{ email: string | null }>(scope, 'profiles');

const auth = new Auth(scope, 'auth', {
	emailPassword: false,
	oidcProviders: {
		google: { issuer: 'https://accounts.google.com', clientId: 'google-client-id', clientSecret: googleSecret },
		github: github({ clientId: 'github-client-id', clientSecret: githubSecret }),
		okta: { issuer: 'https://dev-123.okta.com', clientId: 'okta-id', clientSecret: oktaSecret },
		// The codemod keeps AuthOIDC's deployed stub — and leaves a TODO: see "stubIdp() is local-only" below.
		corp: stubIdp({ unsafeAllowDeployed: true }),
	},
	redirects: { postSignInPath: '/home', allowedRelayOrigins: [relayOrigin('myapp://auth')] },
	allowBearerAuth: true,
	onSignIn: async (user) => {
		await profiles.put(user.userId, { email: user.attributes.email ?? null });
	},
});
export const authApi = auth.createApi();
```

What changes:

- **`emailPassword: false`.** `AuthOIDC` had no password sign-in. Without this line, `Auth` would add email + password and provision a Cognito pool. The codemod adds it.
- **Providers are a record keyed by id.** The key is the id used by `getSignInUrl(context, '<id>')` and by the `signIn:<id>` UI action, the same string the old `name` held. `google()` and `customOidc()` are gone: a generic OIDC provider is a plain `{ issuer, clientId, clientSecret? }` entry. `github()`, `customOauth2()` and `stubIdp()` stay. `customOauth2()` takes `endpoints: { authorization, token, userInfo }` (was `authUrl` / `tokenUrl` / `userInfoUrl`), and `stubIdp()` takes no `name`.
- **Secrets are `AppSetting` references,** never strings or functions. The codemod rewrites `() => setting.get()` to `setting`. It leaves a TODO for a literal or any other form. `clientId` is a plain string.
- **The user object:** `OIDCUser` becomes `AuthenticatedUser`. `user.userId` and `user.username` are unchanged. `email` / `name` are now `user.attributes.email` / `user.attributes.name`, and `provider` is now `user.signInProvider`. `iss` and `sub` are gone: `userId` still carries `` `${iss}:${sub}` ``, `attributes` holds the string claims, and `user.claims` is still there: the provider's verified ID-token claims, so `user.claims.sub` is the raw provider `sub`. It is optional on `AuthenticatedUser` (set for users of an `oidcProviders` entry with `federateVia: 'direct'`, absent for user-pool users), so read it as `user.claims?.sub`. It is server-side only: `getAuthState()` and the sign-in routes don't send it to the browser.
- **No client handle.** `authApi.getClient()` and the `@aws-blocks/bb-auth-oidc/middleware` (or `/client`) import are gone. Federated sign-in buttons come from `getAuthState()`: each provider is a `signIn:<id>` action that carries a `url`, and the `Authenticator` renders it. `auth.handleCallback*`, `handleExchange`, `getAuthorizeParams` and `refreshBearerTokens` are gone too, because `Auth` serves those routes itself under the same `/aws-blocks/auth/*` paths.
- **Redirect options** (`callbackPath`, `signOutPath`, `postSignInPath`, `allowedRelayOrigins`) move under `redirects`. `crossDomain` moves to `session.crossDomain`.
- **The old cookie secret is deleted.** `AuthOIDC` signed its session cookie with an SSM parameter `/<fullId>-cookie-secret-<id>`. `Auth` doesn't use it, so the first deploy deletes it. It only signed the old cookie, which is already ignored, so users see nothing beyond the one re-login.
- **`stubIdp()` is local-only** — see below.

### `stubIdp()` is local-only

`AuthOIDC` served a `stubIdp()` provider everywhere, including from a deployed stack (that is how its e2e ran against a sandbox). `Auth`'s stub is **local-only by default**: it runs in `npm run dev`, and synthesizing a stack that contains it fails with "`stubIdp()` is local-only".

A deployed stub signs users in **without credentials**: anyone who can reach the app can open its account picker and sign in as any of its users (or its built-in default user), with every claim and group they carry. So deploying one is an explicit, opt-in choice: `stubIdp({ …, unsafeAllowDeployed: true })`. With it, synth succeeds with a `@aws-blocks/bb-auth:StubIdpDeployed` warning, and the deployed backend serves the stub under `/aws-blocks/auth/idp/<id>/`, as `AuthOIDC` did. Its issuer is the API Gateway URL, the same one `AuthOIDC`'s deployed stub used, so its users keep their `userId`.

The codemod can't tell whether your stub was ever deployed, so it **keeps `AuthOIDC`'s behaviour**: every migrated `stubIdp(…)` gets `unsafeAllowDeployed: true` and a `TODO(aws-blocks-auth-migrate)` explaining the risk. That keeps "deploy the codemod's output unchanged" true. Then decide, per provider:

- **Only ever used with `npm run dev`:** delete `unsafeAllowDeployed: true`.
- **A disposable test stack (CI e2e, a sandbox):** keep it, and keep that stack free of real data.
- **A stack that holds real users:** remove it and deploy the real provider. If the same backend module also runs locally, choose the provider by environment so `npm run dev` keeps the stub — and make sure the deployed Lambda sees the same choice synth did.

## `AuthOIDC` with `cognitoFederated()`

This is the one `AuthOIDC` setup that loses resources on upgrade. `AuthOIDC` federated through **its own** Cognito pool at construct id `cognito-pool` (named `<fullId>-federation`, always `DESTROY`). `Auth` federates social, SAML and `federateVia: 'cognito'` providers through its `pool`. Switching therefore **deletes the old pool and every shadow user in it**, and creates a new one. Each user signs in once more and gets a new pool record.

```ts
// After (Auth): cognitoFederated({ identityProvider: 'Google' }) and a custom OIDC IdP
import { AppSetting, Scope } from '@aws-blocks/blocks';
import { Auth } from '@aws-blocks/bb-auth';

const scope = new Scope('my-app');
const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });
const entraSecret = new AppSetting(scope, 'entra-secret', { secret: true });

const auth = new Auth(scope, 'auth', {
	emailPassword: false,
	socialProviders: {
		google: { clientId: 'google-oauth-client-id', clientSecret: googleSecret },
	},
	oidcProviders: {
		entra: {
			federateVia: 'cognito',
			issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
			clientId: 'entra-client-id',
			clientSecret: entraSecret,
		},
	},
});
export const authApi = auth.createApi();
```

`identityProvider: 'Google' | 'Facebook' | 'LoginWithAmazon' | 'SignInWithApple'` maps to `socialProviders.google | facebook | amazon | apple`. Any other IdP (one with `idpIssuerUrl`) becomes an `oidcProviders` entry with `federateVia: 'cognito'`. `clientId` is now a plain string, where `cognitoFederated()` took an `AppSetting`. `region` and `cognitoDomain` are gone: the pool is in the stack's region, and the domain is described next.

**The domain prefix.** `Auth` derives a new Cognito domain prefix from the block's `fullId` by default. The deploy then succeeds, but the IdP redirect URI changes, so **re-register `https://<new prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse` (`/saml2/idpresponse` for SAML) in every IdP console.** The prefix is shown in the synthesized template, and in the `UserPoolDomain` resource after the deploy.

To keep the old prefix (and the redirect URIs already registered with each IdP), set `hostedUi: { domainPrefix: '<the old cognitoDomain>' }`. A single deploy then **fails**: CloudFormation creates the new domain before it deletes the old one, and prefixes are globally unique. Use two deploys:

1. Deploy **without** the old Cognito federation. Remove the `cognitoFederated()` entries from `AuthOIDC`, or remove the `AuthOIDC` block if they were its only providers. This deletes the old `cognito-pool` and its domain, which frees the prefix. Cognito-federated sign-in is unavailable until step 2 completes.
2. Switch to `Auth` with `hostedUi: { domainPrefix: '<the old cognitoDomain>' }` and deploy. The registered redirect URIs work again. Check them in each IdP console anyway: the path must match (`/oauth2/idpresponse`, or `/saml2/idpresponse` for SAML).

The domain prefix is create-only: once `Auth` has deployed a domain, don't change `hostedUi.domainPrefix` or the block's id.

### Re-keying `cognitoFederated()` users

**Any data you keyed on these users' `userId` must be re-keyed.** `AuthOIDC` gave a `cognitoFederated()` user `` userId = `${iss}:${sub}` ``, built from the IdP identity (for example `https://accounts.google.com:1098…`). `Auth` makes a hosted-UI federated user a pool user, whose `userId` is the Cognito username (`cognito:username`, for example `Google_1098…`), and whose `userSub` is the new pool's `sub`. Direct-federation users are not affected (their `userId` is unchanged).

The old key is derivable from the new user. Cognito names a federated user `<ProviderName>_<IdP subject>`, and `AuthOIDC` built the issuer as follows:

| `identityProvider` | old `iss` |
|---|---|
| `Google` | `https://accounts.google.com` |
| `Facebook` | `https://www.facebook.com` |
| `LoginWithAmazon` | `https://www.amazon.com` |
| `SignInWithApple` | `https://appleid.apple.com` |
| a custom OIDC IdP named `<name>` in Cognito | `oidc:<name>` |
| a SAML IdP named `<name>` | `saml:<name>` |

Re-key lazily on each user's first sign-in, and key new data on `userSub` from then on:

```ts
import { KVStore, Scope } from '@aws-blocks/blocks';
import { Auth, type AppSettingRef } from '@aws-blocks/bb-auth';

declare const scope: Scope;
declare const googleSecret: AppSettingRef;
const profiles = new KVStore<{ displayName: string }>(scope, 'profiles');

/** `AuthOIDC`'s `userId` for a user Cognito calls `<ProviderName>_<subject>`. */
function legacyUserId(cognitoUsername: string): string | null {
	const cut = cognitoUsername.indexOf('_');
	if (cut < 0) return null;
	const provider = cognitoUsername.slice(0, cut);
	const subject = cognitoUsername.slice(cut + 1);
	const iss: Record<string, string> = {
		Google: 'https://accounts.google.com',
		Facebook: 'https://www.facebook.com',
		LoginWithAmazon: 'https://www.amazon.com',
		SignInWithApple: 'https://appleid.apple.com',
	};
	return `${iss[provider] ?? `oidc:${provider}`}:${subject}`;
}

const auth = new Auth(scope, 'auth', {
	emailPassword: false,
	socialProviders: { google: { clientId: 'google-oauth-client-id', clientSecret: googleSecret } },
	onSignIn: async (user) => {
		const oldKey = legacyUserId(user.userId);
		if (oldKey === null) return;
		const old = await profiles.get(oldKey);
		if (old !== null && (await profiles.get(user.userSub)) === null) {
			await profiles.put(user.userSub, old);
			await profiles.delete(oldKey);
		}
	},
});
export const authApi = auth.createApi();
```

Before relying on it, check the username format for one real user in the Cognito console (provider name casing can differ between IdP types). For a SAML provider, change the `oidc:` fallback to `saml:`.

## `AuthBasic`

**There is no migration path.** Cognito can't import `AuthBasic`'s bcrypt password hashes, so every existing user must **sign up again** after the switch. The codemod rewrites the code and marks every `AuthBasic` block with a TODO, but the decision to switch is yours.

```ts
// Before (AuthBasic)
import { AuthBasic, AuthBasicErrors } from '@aws-blocks/bb-auth-basic';

const auth = new AuthBasic(scope, 'auth', {
	sessionDuration: 86_400,
	passwordPolicy: { minLength: 10, requireSpecialChars: true },
	codeDelivery: async (username, code) => { await sendEmail(username, code); },
});
```

```ts
// After (Auth)
import { Scope } from '@aws-blocks/blocks';
import { Auth } from '@aws-blocks/bb-auth';

const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
	session: { ttlSeconds: 86_400 },
	emailPassword: {
		passwordPolicy: {
			minLength: 10,
			requireSymbols: true,
			// AuthBasic required none of these by default; Auth requires all of them.
			requireUppercase: false,
			requireLowercase: false,
			requireDigits: false,
		},
	},
	// Local development only: on AWS, Cognito emails the codes itself.
	codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
});
export const authApi = auth.createApi();
```

What happens on the first deploy:

- **A new Cognito pool is created.** `AuthBasic`'s `users` and `codes` tables (`<fullId>-users`, `<fullId>-codes`) and its `/<fullId>-jwt-secret` parameter leave the stack. Under `BlocksPresets.production` they are **retained**, orphaned outside the stack. Under `BlocksPresets.sandbox` they are **deleted**.
- **Signed-in users are signed out.** The `auth_<fullId>` session cookie keeps its name but holds an `AuthBasic` JWT. `Auth` rejects it and clears it; it is never treated as signed in and never causes an error.

**Export your users first** if you need them, for example to invite each one to sign up again. While the old block is still deployed, run a read-only export:

```bash
aws dynamodb scan --table-name <fullId>-users --output json > authbasic-users.json
```

Each item is keyed by username and holds the bcrypt hash, which you can't import into Cognito. Delete the export once you've used it. Locally, the mock's data is under `.bb-data/<fullId>-users/`.

Behaviour that changes for your users and your code:

- **Sign-up needs the emailed code.** Every deployed sign-up confirms the email address with a code. With `emailPassword.autoSignIn` (on by default) the user is signed in once they enter it, with no second password entry. `AuthBasic`'s instant "sign up and you're in" is gone.
- **Cognito's default sender sends at most 50 emails a day.** That covers confirmation, password-reset and email-MFA codes, which is enough for development but not for production. To send at volume, configure Amazon SES on a pool you manage and wrap it with `userPool: Auth.fromExisting(userPoolId, clientId)`.
- **`codeDelivery` runs locally only.** On AWS, Cognito sends the codes; your hook no longer runs there.
- **The password policy defaults are stricter.** `Auth` requires upper case, lower case, digits and symbols unless you turn them off. `AuthBasic` required none of them. `requireSpecialChars` is now `requireSymbols`.
- **The default session lifetime changes** from 24 hours to 400 days unless you set `session.ttlSeconds`. The codemod carries `sessionDuration` over when you set it.
- `signIn()` returns `{ status: 'signedIn', user }` or `{ status: 'continueSignIn', nextStep }` instead of the user. `buildApi()` is gone: use `createApi()` with the `Authenticator`. The user type has no `createdAt`.
- Error names change. See [Error names](#error-names), in particular the split of `InvalidCodeException`.

## Before every deploy: the checklist

- [ ] **First deploy the codemod's output unchanged, commit the generated baseline, and only then change the configuration.** An `AuthCognito` app has no baseline, so the first `Auth` synth has nothing to compare against: it writes the baseline from whatever the configuration is, and passes. If that first configuration drops the pool, the deploy removes `pool` from the template and CloudFormation applies the **old** template's deletion policy. `AuthCognito`'s was `DESTROY` unless you set `removalPolicy: 'retain'`, so the pool and every user in it are deleted. Two configurations do this: `emailPassword: false` with only directly federated OIDC providers, and `userPool: Auth.fromExisting(<the block's own pool id>)`. Synth only warns (`@aws-blocks/bb-auth:FirstBaselineWithoutPool`), and the deploy-time guard exists only while the block owns a pool. An unchanged first deploy closes that gap twice over. The committed baseline then records the pool, so synth refuses to remove it. And that same deploy moves a production-preset pool to `DeletionPolicy: Retain` with deletion protection on ([`AuthCognito`](#authcognito), "Deletion policy follows the stack preset"), so a later mistake can no longer delete it. Under the sandbox preset the pool stays `Delete`; adding `removalPolicy: 'retain'` to this first deploy is safe and recommended for any pool that holds real users. The one change the first deploy may need is resolving the codemod's TODOs (for example, removing `preferredChallenge: 'EMAIL_OTP'`, see [`AuthCognito`](#authcognito)).
- [ ] **The id argument of every auth block is exactly what it was.** So is the scope it is constructed under.
- [ ] **Commit the immutability baseline.** On the first synth, `Auth` writes `aws-blocks/baselines/<stack>/<fullId>.auth-pool.json` and reports "commit it". The file records the user-pool properties that Cognito can't change on an existing pool (sign-in attributes, username case sensitivity, required attributes, existing custom attributes). From then on, synth refuses a change to them, and the deploy refuses it again before the pool is updated. Without the committed file, CI's synth can't see the change. If you deploy only from CI, make the deploy workflow commit the baselines its synth writes (see "The CI caveat" in [DESIGN.md](./DESIGN.md#immutability-guard-q5)); otherwise the production baseline never reaches the repository and synth never refuses anything.
- [ ] **Don't rename or remove an `Auth` block by accident.** Synth fails when a committed baseline belongs to a block that no longer exists, because CloudFormation would delete its pool and every user in it. If you really mean it, set `removalPolicy: 'retain'` and deploy first, then re-baseline deliberately with `BLOCKS_AUTH_REBASELINE=<fullId>` on the synth/deploy command, and commit the deleted baseline file. The variable must name the block; `=1` does nothing.
- [ ] **Review every auth error check** (the codemod marks each one). `InvalidCodeException` is now two names. See [Error names](#error-names).
- [ ] **Expect the cookie cutover.** `AuthCognito` sessions stay valid. `AuthBasic` and `AuthOIDC` users are signed out once.
- [ ] **Email volume:** with Cognito's default sender, sign-up and reset codes are capped at 50 a day.
- [ ] **`stubIdp()` providers:** for each `unsafeAllowDeployed: true` the codemod added, decided whether that stack may expose a credential-free sign-in (test stacks only), or removed the flag ([`stubIdp()` is local-only](#stubidp-is-local-only)).
- [ ] **`cognitoFederated()` apps:** domain prefix plan chosen (new prefix, then re-register redirect URIs; or two deploys), and data keyed on `userId` re-keyed.
- [ ] **`AuthBasic` apps:** users exported if needed, and you've decided how to tell them to sign up again.
- [ ] Review `cdk diff` against the deployed stack. For an `AuthCognito` app, it must show **no replacement** of `AWS::Cognito::UserPool` or `AWS::Cognito::UserPoolClient`. If it does, stop: something changed an id.

## Option mapping

### `AuthCognito` → `Auth`

| `AuthCognito` option | `Auth` option |
|---|---|
| `selfSignUp` | `emailPassword.selfSignUp` |
| `passwordPolicy` | `emailPassword.passwordPolicy` |
| `signInWith: 'email'` | `users.signInWith: ['email']` (always an array) |
| `userAttributes` | `users.attributes` |
| `groups` | `users.groups` |
| `authFlowType` | `users.authFlow` (`'USER_PASSWORD_AUTH'` or `'USER_AUTH'`) |
| `preferredChallenge` | `users.preferredChallenge` |
| `deviceTracking` | `users.deviceTracking` |
| `mfa` + `mfaTypes` | `mfa: { mode, types }`; with no `mfaTypes`, `types: ['SMS']` |
| `enablePasskeys: true` + `webAuthnRelyingParty: { id, origins, userVerification }` | `passkeys: { relyingPartyId, origins, userVerification }` |
| `sessionTtlSeconds` | `session.ttlSeconds` |
| `crossDomain` | `session.crossDomain` |
| `admin`, `featurePlan`, `removalPolicy`, `userPool`, `logger`, `codeDelivery` | unchanged |
| `AuthCognito.fromExisting(…)` | `Auth.fromExisting(…)` |

### `AuthOIDC` → `Auth`

| `AuthOIDC` option | `Auth` option |
|---|---|
| (no password sign-in) | `emailPassword: false` |
| `providers: [google({ clientId, clientSecret })]` | `oidcProviders: { google: { issuer: 'https://accounts.google.com', clientId, clientSecret } }` |
| `providers: [customOidc({ name, issuerUrl, … })]` | `oidcProviders: { <name>: { issuer: issuerUrl, … } }` |
| `providers: [github({ … })]` | `oidcProviders: { github: github({ … }) }` |
| `providers: [customOauth2({ name, authUrl, tokenUrl, userInfoUrl, … })]` | `oidcProviders: { <name>: customOauth2({ name, endpoints: { authorization, token, userInfo }, … }) }` |
| `providers: [stubIdp({ name, … })]` | `oidcProviders: { <name>: stubIdp({ …, unsafeAllowDeployed: true }) }` — local-only without the flag; see [`stubIdp()` is local-only](#stubidp-is-local-only) |
| `providers: [cognitoFederated({ identityProvider: 'Google', … })]` | `socialProviders: { google: { clientId, clientSecret } }` (also `facebook`, `amazon`, `apple`) |
| `providers: [cognitoFederated({ name, idpIssuerUrl, … })]` | `oidcProviders: { <name>: { federateVia: 'cognito', issuer: idpIssuerUrl, … } }` |
| `clientSecret: () => setting.get()` | `clientSecret: setting` |
| `callbackPath`, `signOutPath`, `postSignInPath`, `allowedRelayOrigins` | `redirects.*` |
| `crossDomain` | `session.crossDomain` |
| `allowBearerAuth`, `onSignIn`, `onSignOut`, `logger` | unchanged (`onSignIn` / `onSignOut` receive an `AuthenticatedUser`) |

### `AuthBasic` → `Auth`

| `AuthBasic` option | `Auth` option |
|---|---|
| `sessionDuration` | `session.ttlSeconds` |
| `passwordPolicy` (`requireSpecialChars`) | `emailPassword.passwordPolicy` (`requireSymbols`) |
| `crossDomain` | `session.crossDomain` |
| `codeDelivery` | `codeDelivery` (local development only; three arguments: `username, code, purpose`) |
| `logger` | `logger` |

## Names, methods and types

| Old | New |
|---|---|
| `AuthBasic`, `AuthCognito`, `AuthOIDC` | `Auth` |
| `AuthBasicErrors`, `AuthCognitoErrors`, `AuthOIDCErrors` | `AuthErrors` |
| `AuthCognitoOptions` / `AuthCognitoMockOptions` / `AuthBasicOptions` | `AuthOptions` / `AuthMockOptions` / `AuthMockOptions` |
| `CognitoUser`, `OIDCUser`, `AuthBasicUser` | `AuthenticatedUser` |
| `AuthOIDCErrorName` | `AuthErrorName` |
| `MFAPreference`, `MFAPreferenceInput`, `MFASetting` | `MfaPreference`, `MfaPreferenceInput`, `MfaSetting` |
| `FetchAuthSessionOptions` | `GetAuthSessionOptions` |
| `WebAuthnRelyingPartyConfig` | `PasskeyOptions` (`relyingPartyId` instead of `id`) |
| `auth.fetchAuthSession()` | `auth.getAuthSession()` |
| `auth.fetchUserAttributes()` | `auth.getUserAttributes()` |
| `auth.fetchMFAPreference()` | `auth.getMfaPreference()` |
| `auth.fetchDevices()` | `auth.scanDevices()` |
| `auth.setUpTOTP()` / `verifyTOTPSetup()` / `updateMFAPreference()` | `auth.setUpTotp()` / `verifyTotpSetup()` / `updateMfaPreference()` |
| `auth.updateUserAttribute(ctx, name, value)` | `auth.updateUserAttributes(ctx, { [name]: value })`, which returns a record keyed by attribute name |
| `auth.confirmSignIn(session, { code }, ctx)` | `auth.confirmSignIn(session, code, ctx)` |
| `@aws-blocks/bb-auth-cognito/ui` | `@aws-blocks/bb-auth/ui` |
| `cognitoOverrides()` (`/ui`) | `authOverrides()` |
| `CognitoActionName`, `CognitoNextStepName`, `CognitoActionFields` (`/ui`) | `AuthActionName`, `AuthNextStepName`, `AuthActionFields` |
| `CognitoActionOverride`, `CognitoAuthenticatorOptions` (`/ui`) | `AuthTypedActionOverride`, `AuthTypedAuthenticatorOptions` |

## Error names

Errors cross the wire by `name`, and `hasAuthError(state, name)` takes a plain string. So a renamed error doesn't break the build: the check just stops matching. Match on `AuthErrors` with `isAuthError(e, AuthErrors.X)` (or `isBlocksError`) and `hasAuthError(state, AuthErrors.X)`.

| Old name | New name |
|---|---|
| `InvalidCredentialsException` (`AuthBasicErrors.InvalidCredentials`) | `NotAuthorizedException` (`AuthErrors.NotAuthorized`) |
| `UserAlreadyExistsException` (`AuthBasicErrors.UserAlreadyExists`) | `UsernameExistsException` (`AuthErrors.UserAlreadyExists`) |
| `SessionExpiredException` (`AuthBasicErrors.SessionExpired`) | `NotAuthenticatedException` (`AuthErrors.NotAuthenticated`) |
| **`InvalidCodeException`** (`AuthBasicErrors.InvalidCode`) | **split:** `CodeMismatchException` for a wrong code, `ExpiredCodeException` for an expired or missing one |
| **`AuthOIDCEngineError`** (`cognitoFederated()` engine) | **split:** `ProviderNotConfiguredException`, `InvalidStateException`, `InvalidCallbackException`, `IdpErrorException`, `TokenExpiredException` |
| `InvalidPasswordException`, every `AuthCognitoErrors` name, every `AuthOIDCErrors` name | unchanged |

The codemod renames the constants and the exact string literals above. It maps `InvalidCodeException` to `CodeMismatchException`, with a TODO to add the `ExpiredCodeException` case if you handled expiry. It marks every auth error check for review, because some flows changed which error they return:

- Sign-up through the sign-in UI answers an existing username like a new sign-up, unless you set `emailPassword.revealExistingUsers: true`. So `UsernameExistsException` doesn't reach the client on that path by default.
- Public flows never return `UserNotFoundException`. Only `auth.admin` does.
- A Cognito error with no canonical name reaches the client as `InternalErrorException` (retriable), not under its raw Cognito name.

## What the codemod can't map

These get a TODO (or a compile error) and need a person:

- **Every `AuthBasic` block:** the switch loses users (see [`AuthBasic`](#authbasic)).
- **Options it can't see:** an options object passed by variable, spread into the call, or built by a function. Unknown option keys are kept as they are.
- **Providers it can't see:** a `providers` value that isn't an array literal, or an entry that isn't an inline `google()` / `github()` / `customOidc()` / `customOauth2()` / `stubIdp()` / `cognitoFederated()` call. A provider name that isn't a string literal becomes a computed key.
- **Secrets that aren't `() => setting.get()`:** inline strings, environment variables, other functions. A `clientId` read from an `AppSetting` must become the literal client id.
- **`cognitoFederated()`:** the domain prefix decision, re-keying data on `userId`, and Sign in with Apple's `teamId` / `keyId` / `privateKey`. A social provider whose old `name` wasn't its fixed id (`google`, `facebook`, `amazon`, `apple`) changes id.
- **The result of `updateUserAttribute()` when you use it:** it's now a record keyed by attribute name.
- **`signUp()` with `autoSignIn: false` or a non-literal value, `signIn()` with `cognitoSession`, and `confirmSignIn()` with a computed response.**
- **`AuthOIDC` members with no equivalent:** `getClient()`, the side-effect `/middleware` import, and what `/middleware` and `/client` exported for the client handle (`AuthOIDCClient`, `handle401`, `AuthStateMeta`, …), `handleCallback`, `handleCallbackDispatch`, `handleExchange`, `getAuthorizeParams`, `refreshBearerTokens`, `signInRoutePath`, `signInBasePath`, and the `providers` / `callbackPath` / `signOutPath` / `postSignInPath` / `allowBearerAuth` getters.
- **`OIDCUser` fields** `iss`, `sub`, `provider`, `email` and `name` read in `onSignIn` / `onSignOut` (TODO), or anywhere else (compile error). `claims` is still there but now optional (TODO in `onSignIn` / `onSignOut`).
- **Exports that are gone:** `makeExternalUserPoolRef` (use `Auth.fromExisting`), `envVarNames`, `isRetriableAuthError`, `AuthFlowType`, `SignInWith`, `ConfirmSignInResponse`, `OIDCClient`, `SessionStore`, `SessionRecord`, and the `@aws-blocks/auth-common` types that `@aws-blocks/bb-auth-basic` re-exported (import them from `@aws-blocks/blocks`).
- **Method calls it can't trace to an old block:** for example `ctx.auth.fetchDevices()`. In a file that uses an old block, these get a TODO naming the new method.
- **Namespace imports of the old packages** (`import * as cognito from '@aws-blocks/bb-auth-cognito'`), uses of an `@aws-blocks/blocks` namespace it can't follow (`blocks['AuthCognito']`, `const { AuthCognito } = blocks`), and dynamic `import()` / `require()` of the old packages.
- **An import that names nothing** (`import {} from '@aws-blocks/bb-auth-cognito/ui'`): left as it is, with a TODO, and the summary lists the file as needing attention.
- **`package.json`:** the codemod rewrites only source files. Swap the dependencies yourself.
