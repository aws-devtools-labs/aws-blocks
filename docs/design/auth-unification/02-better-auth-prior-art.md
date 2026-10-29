# better-auth as prior art for a unified AWS Blocks auth Building Block

> **Status:** research / planning input. No source changes.
> **Scope:** what better-auth's DX gets right, expressed as decisions we can copy, adapt, or explicitly reject for a single AWS Blocks auth Building Block backed by Cognito.
> **Sources:** `https://better-auth.com/docs/*` (v1.7 docs line, fetched as the `.md` variants the site publishes) and the `better-auth/better-auth` repo at `main` for the type definitions the docs render as components. Adjacent references: AWS Amplify Gen2 `defineAuth`, Auth.js v5, Clerk — read from their docs repos and library source, since none of those three serves a `.md` variant. §8.0 is a survey of `packages/bb-auth-{basic,cognito,oidc}` and `packages/auth-common` at HEAD.
>
> **How to read this:** §1–§5 are what better-auth does and why it feels good. §6 is what we must reject. §7 is the comparative check. **§8.0 is the most actionable part** — it's where the three existing BBs actually diverge, and several of better-auth's "best ideas" turn out to already exist in `bb-auth-oidc`. §9 splits the recommendations into *adopt* (new) and *consolidate* (already here, unevenly).

---

## 0. Executive read

better-auth is the strongest available answer to the exact question we are asking: *how does one object turn on email/password and N federated providers without making the user choose a package up front?* Its answer is three-fold:

1. **One function, one options object, feature flags by key presence.** `emailAndPassword` is a key. `socialProviders` is a key whose value is a keyed record of provider ids. Adding a second provider is adding a key, never a second import or a second construct.
2. **A single common provider interface (`OAuthProvider`) with per-provider option types (`ProviderOptions<Profile>` extended per provider).** Named providers are factories over that interface; a "generic OIDC" provider is *the same interface* fed by discovery instead of hardcoded endpoints.
3. **Progressive disclosure via plugins that are just entries in `plugins: []`**, with types flowing server → client by *type-only import* (`$InferServerPlugin`, `typeof auth`), never codegen.

The parts we must **not** copy: better-auth owns `user`/`session`/`account`/`verification` tables and a migration CLI. We don't and can't — Cognito is the engine. Our equivalent of "the account table" is a Cognito user pool plus identity-provider records, most of which are **immutable after create** or replace-on-change in CloudFormation. That inverts several of better-auth's cheapest moves (runtime provider registration, `additionalFields` schema extension, "just add a provider key") into CDK-synth-time concerns for us.

**The one surprise from surveying our own code (§8.0):** we are further along than the framing above suggests. `bb-auth-oidc` already has a `kind`-discriminated provider union with named factories (better-auth's tiering, built), `SecretLike` is a better secret reference than Amplify's `secret('NAME')`, MFA is already an option key rather than a plugin, `ProviderName<P>` and `AuthCognito<const O>` already close the server→client type-flow gap that *all four* references leave open, and `stubIdp` gives us a fully offline IdP that neither Amplify nor Clerk can match. So this refactor is less "import better-auth's design" and more **"pick the best of what three BBs already do and make it one thing"** — with genuinely new work concentrated in a cross-mechanism policy gate, a config-derived state machine, and an error vocabulary that currently has three incompatible spellings for the same 401.

---

## 1. The config shape

### 1.1 The minimal instance

The whole server is one call, exported as `auth`, and the *only* required property in the minimal path is nothing at all:

```ts title="auth.ts"
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  //...
});
```
— `/docs/installation`

Database is a **top-level key that accepts a driver instance directly** (not a wrapper, not a provider string):

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

export const auth = betterAuth({
    database: new Database("./sqlite.db"),
})
```

…or an adapter when an ORM is in play:

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db"; // your drizzle instance

export const auth = betterAuth({
    database: drizzleAdapter(db, {
        provider: "pg", // or "mysql", "sqlite"
    }),
});
```

> Note the escape valve that matters most to us: **omitting `database` is legal** and silently selects stateless mode. "If you don't pass a database configuration, Better Auth will automatically enable stateless mode." (`/docs/concepts/session-management`) That is a real progressive-disclosure decision: the zero-config path is not "error: choose a store", it's "cookie-only sessions, and we'll tell you which plugins won't work."

### 1.2 Email/password **and** N social providers in one object

This is the single most important snippet for our design — both features are sibling keys of the same object, and the second provider is one more key in a record:

```ts title="auth.ts"
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  //...other options
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    },
  },
});
```
— `/docs/installation` (the step literally titled "Authentication Methods")

Scaling to several named providers is purely additive — no arrays, no ordering, no `providers.push`:

```ts title="auth.ts"
export const auth = betterAuth({
	socialProviders: {
		google: {
			clientId: "your-client-id",
			clientSecret: "your-client-secret",
			redirectURI: "https://example.com/api/auth/callback/google"
		},
		github: {
			clientId: "your-client-id",
			clientSecret: "your-client-secret",
			redirectURI: "https://example.com/api/auth/callback/github"
		}
	},
})
```
— `/docs/reference/options#socialproviders`

**Cognito is itself one of those keys** — worth reading closely, because it is the closest thing in the ecosystem to the shape we need for "Cognito-native", and it treats Cognito as *just another OIDC-ish provider with three extra required fields*:

```ts title="auth.ts"
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  socialProviders: {
    cognito: {
      clientId: process.env.COGNITO_CLIENT_ID as string,
      clientSecret: process.env.COGNITO_CLIENT_SECRET as string,
      domain: process.env.COGNITO_DOMAIN as string, // e.g. "your-app.auth.us-east-1.amazoncognito.com"
      region: process.env.COGNITO_REGION as string, // e.g. "us-east-1"
      userPoolId: process.env.COGNITO_USERPOOL_ID as string,
      identityProvider: "Google", // optional: skip the hosted UI picker
    },
  },
})
```
— `/docs/authentication/cognito`

### 1.3 How the option object is typed (the mechanism behind "just add a key")

`socialProviders` is a **mapped type over a registry of provider factories**, where each value's option type is derived from that factory's parameter. This is the trick that makes `google: { … }` autocomplete Google-specific options while `cognito: { … }` autocompletes `domain`/`region`/`userPoolId`:

```ts
// packages/core/src/social-providers/index.ts
export const socialProviders = {
	apple, atlassian, cloudflare, cognito, discord, facebook, figma, github,
	microsoft, google, huggingface, slack, spotify, twitch, twitter, dropbox,
	kick, linear, linkedin, gitlab, tiktok, reddit, roblox, salesforce, vk,
	zoom, notion, kakao, naver, line, paybin, paypal, polar, railway, vercel,
	wechat,
};

export const socialProviderList = Object.keys(socialProviders) as [
	"github",
	...(keyof typeof socialProviders)[],
];

export type SocialProviders = {
	[K in SocialProviderList[number]]?: AwaitableFunction<
		Parameters<(typeof socialProviders)[K]>[0] & {
			enabled?: boolean | undefined;
		}
	>;
};
```

Two design consequences worth stealing:

- Every provider entry accepts `enabled?: boolean`, so a provider can be *configured but switched off* without deleting its config block (useful for stage-gated providers).
- The value may be an `AwaitableFunction` of the options — i.e. lazily/asynchronously resolved config, which is how secrets can be fetched rather than inlined.

### 1.4 The rest of the surface, so you can see the altitude

Top-level keys of `betterAuth({...})` (from `/docs/reference/options`, in doc order):
`appName`, `baseURL`, `basePath`, `trustedOrigins`, `secret`, `secrets`, `database`, `secondaryStorage`, `emailVerification`, `emailAndPassword`, `socialProviders`, `plugins`, `user`, `session`, `account`, `verification`, `rateLimit`, `advanced`, `logger`, `databaseHooks`, `onAPIError`, `hooks`, `disabledPaths`, `telemetry`.

That's ~24 top-level keys for a library that covers 2FA, orgs, SSO, SAML, SCIM, passkeys and payments — because **everything past the core is a plugin**, and plugins take their own options. The core object stays readable.

---

## 2. The provider abstraction

### 2.1 The common interface

There is exactly one server-side provider contract. Every named provider, and the generic-OAuth plugin, produce objects satisfying it:

```ts
// packages/core/src/oauth2/oauth-provider.ts (trimmed to the shape; JSDoc elided)
export interface OAuthProvider<
	T extends object = object,
	O extends object = Partial<ProviderOptions>,
> {
	id: LiteralString;
	name: string;
	callbackPath?: string | undefined;
	createAuthorizationURL: (data: {
		state: string;
		codeVerifier: string;
		scopes?: string[] | undefined;
		redirectURI: string;
		display?: string | undefined;
		loginHint?: string | undefined;
		idTokenNonce?: string | undefined;
		additionalParams?: Record<string, string> | undefined;
	}) => Awaitable<URL>;
	accountSubject: OAuthAccountSubject<T>;
	validateAuthorizationCode: (data: {
		code: string;
		redirectURI: string;
		codeVerifier?: string | undefined;
		deviceId?: string | undefined;
	}) => Promise<OAuth2Tokens | null>;
	getUserInfo: (token: OAuth2Tokens & { /* … */ }) => Promise<{
		user: OAuth2UserInfo;
		data: T;
	} | null>;
	refreshAccessToken?: ((refreshToken: string, ctx?: OAuthRefreshContext) => Promise<OAuth2Tokens>) | undefined;
	revokeToken?: ((token: string) => Promise<void>) | undefined;
	createEndSessionURL?: ((data: { idToken?: string | null; postLogoutRedirectURI?: string; state?: string }) => Awaitable<URL | null>) | undefined;
	idToken?: OAuthIdTokenConfig | undefined;
	issuer?: string | undefined;
	requiresIdTokenNonce?: boolean | undefined;
	disableImplicitSignUp?: boolean | undefined;
	disableSignUp?: boolean | undefined;
	allowIdpInitiated?: boolean | undefined;
	options?: O | undefined;
}
```

Five things here are load-bearing lessons, not incidental:

1. **Normalization target is deliberately tiny.** The provider's job is to return a *mutable local-user projection* plus the raw profile:

    ```ts
    /** Mutable local-user attributes normalized from an OAuth provider profile. */
    export type OAuth2UserInfo = {
    	/** Provider identity belongs in raw profile data and `accountSubject`. */
    	id?: never;
    	name?: string | undefined;
    	email?: (string | null) | undefined;
    	image?: string | undefined;
    	emailVerified: boolean;
    };
    ```

    `id?: never` is a *type-level guard*: the normalized user literally cannot carry identity.

2. **Identity is a separate, non-overridable resolver.** `accountSubject` reads the raw verified profile, and the docs state the rule twice: "`mapProfileToUser` cannot set the account subject. This keeps local profile mapping separate from account recognition." The Cognito provider is a one-liner: `accountSubject: ({ profile }) => profile.sub`.

3. **Security decisions are declarative, not per-provider code.** `idToken?: OAuthIdTokenConfig` replaces "each provider implements a boolean verify" precisely so verification is centralized and **fail-closed**: "a provider without a config cannot accept a forged token by omission." Same idea as our `synthGuard` — make the unsafe default impossible to reach by omission.

4. **Per-provider policy knobs live on the provider, not globally.** `disableSignUp`, `disableImplicitSignUp`, `requireEmailVerification`, `allowIdpInitiated` are per-provider. The docs are explicit that `emailAndPassword.requireEmailVerification` does **not** gate social sign-in; each provider opts in. This avoids the classic "one global flag means the wrong thing for one provider" trap.

5. **`options?: O` keeps the provider's own configuration attached to the provider object** rather than in a side table.

The user-facing per-provider options are a generic base plus provider extensions:

```ts
export type ProviderOptions<Profile extends object = object> = {
	clientId?: LiteralString | string[] | undefined;
	clientSecret?: string | undefined;
	scope?: string[] | undefined;
	disableDefaultScope?: boolean | undefined;
	redirectURI?: string | undefined;
	authorizationEndpoint?: string | undefined;
	clientKey?: string | undefined;
	disableIdTokenSignIn?: boolean | undefined;
	verifyIdToken?: ((token: string, nonce?: string, ctx?: GenericEndpointContext) => Promise<boolean>) | undefined;
	getUserInfo?: ((token: OAuth2Tokens) => Promise<{ user: OAuth2UserInfo & Record<string, unknown>; data: Profile } | null>) | undefined;
	refreshAccessToken?: ((refreshToken: string) => Promise<OAuth2Tokens>) | undefined;
	mapProfileToUser?: OAuthProfileMapper<Profile> | undefined;
	disableImplicitSignUp?: boolean | undefined;
	disableSignUp?: boolean | undefined;
	prompt?: ("select_account" | "consent" | "login" | "none" | "select_account consent") | undefined;
	responseMode?: ("query" | "form_post") | undefined;
	overrideUserInfoOnSignIn?: boolean | undefined;
	requireEmailVerification?: boolean | undefined;
};
```

…and a named provider extends it with only its genuinely provider-specific fields:

```ts
export interface CognitoOptions extends ProviderOptions<CognitoProfile> {
	clientId: string | string[];
	/** The Cognito domain (e.g., "your-app.auth.us-east-1.amazoncognito.com") */
	domain: string;
	/** AWS region where User Pool is hosted (e.g., "us-east-1") */
	region: string;
	userPoolId: string;
	requireClientSecret?: boolean | undefined;
	identityProvider?: string | undefined;
}
```

> **Takeaway for us:** `BaseProviderOptions` + `interface XProviderOptions extends BaseProviderOptions` is a clean way to have `cognitoNative`, `google`, `oidc` share `scopes`/`callbackPath`/`enabled` while each adds only its own required fields — and it gives per-key autocomplete for free.

### 2.2 Generic OIDC vs a named provider

A named provider is a key in `socialProviders`. A generic one is an **entry in a plugin's `config: []` array with a user-chosen `providerId`** — and critically, *it then behaves identically at the call site*:

```ts title="auth.ts"
import { betterAuth } from "better-auth"
import { genericOAuth } from "better-auth/plugins"

export const auth = betterAuth({
    // ... other config options
    plugins: [
        genericOAuth({
            config: [
                {
                    providerId: "provider-id",
                    clientId: "test-client-id",
                    clientSecret: "test-client-secret",
                    discoveryUrl: "https://auth.example.com/.well-known/openid-configuration",
                    // ... other config options
                },
                // Add more providers as needed
            ]
        })
    ]
})
```

```ts
// identical client call, named or generic:
await authClient.signIn.social({ provider: "provider-id", callbackURL: "/dashboard" })
```

The docs are explicit: "Providers are registered as **first-class social providers** and use the standard `signIn.social` flow, with PKCE and issuer validation enabled by default."

The generic config object:

```ts
interface GenericOAuthConfig {
  providerId: string;
  accountSubject?: (context: OAuthAccountKeyContext<GenericOAuthUserInfo>) => string | number | Promise<string | number>;
  discoveryUrl?: string;
  requireIdTokenVerification?: boolean;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  endSessionEndpoint?: string;
  postLogoutRedirectURI?: string;
  disableProviderLogout?: boolean;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuth?: TokenEndpointAuth;
  scopes?: string[];
  redirectURI?: string;
  responseType?: string;
  prompt?: string;
  pkce?: boolean;
  accessType?: string;
  accessTokenExpiresIn?: number;
  getUserInfo?: (tokens: OAuth2Tokens) => Promise<GenericOAuthUserInfo | null>;
}
```

Notable properties of this design:

- **`discoveryUrl` collapses four fields into one.** "If provided, endpoints like `authorizationUrl`, `tokenUrl`, and `userInfoUrl` will be auto-discovered at server startup." Explicit endpoints remain as a fallback "while discovery is temporarily unavailable."
- **Discovery buys you security, not just brevity.** With a `jwks_uri`, id_tokens are verified (signature/issuer/audience/alg) and bound to a server-generated OIDC `nonce`. Providers configured with explicit endpoints *cannot* use id-token sign-in and return `ID_TOKEN_NOT_SUPPORTED`. A capability is tied to how you configured it, and the failure is a named error rather than a silent downgrade.
- **Degraded startup instead of a hard crash.** "Better Auth skips a provider when discovery returns invalid verification metadata… while keeping other authentication features available. A skipped provider is retried when the auth instance is recreated." One bad IdP does not take down sign-in.
- **The escape hatches are a documented table**, which is a docs pattern worth copying verbatim:

  | Need | Config field |
  | --- | --- |
  | Provider uses non-standard token exchange (GET, custom params) | `getToken` |
  | Provider returns a non-standard user profile | `getUserInfo` |
  | You need to map profile fields to your user model | `mapProfileToUser` |
  | Provider requires extra authorization parameters | `authorizationUrlParams` |
  | Provider requires extra token parameters | `tokenUrlParams` |
  | Provider requires custom HTTP headers | `discoveryHeaders`, `authorizationHeaders` |
  | Provider does not support OIDC discovery | Set `authorizationUrl`, `tokenUrl`, `userInfoUrl` explicitly |
  | Provider uses a non-standard immutable user identifier | Set `accountSubject` |
  | Provider rejects PKCE | Set `pkce: false` |

- **"Provider helpers" are the middle rung of progressive disclosure.** Between "named provider" and "raw generic config" there's a factory that returns a `GenericOAuthConfig`:

  ```ts title="provider.ts"
  import type { BaseOAuthProviderOptions, GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

  export interface ExampleOptions extends BaseOAuthProviderOptions {}

  export function example(options: ExampleOptions): GenericOAuthConfig<"example"> {
    return {
      providerId: "example",
      discoveryUrl: "https://auth.example.com/.well-known/openid-configuration",
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      tokenEndpointAuth: options.tokenEndpointAuth,
      scopes: options.scopes ?? ["openid", "email", "profile"],
      redirectURI: options.redirectURI,
    };
  }
  ```

  Used as `genericOAuth({ config: [ slack({ clientId, clientSecret }) ] })`. Built-ins exist for Auth0, Keycloak, Okta, Microsoft Entra ID, etc. **This is the single most transplantable idea in the whole library for us**: a named provider can be *a pure function returning the generic config*, which means our "Cognito-native", "Google-via-Cognito" and "generic OIDC" providers can be one runtime code path with three ergonomic front doors.

- **A third tier exists for runtime-registered IdPs** (`@better-auth/sso`), where providers are rows, not config: `POST /sso/register` with `{ providerId, issuer, domain, oidcConfig }`, and sign-in is resolved by *email domain*, org slug, or provider id:

  ```ts
  await authClient.sso.register({
      providerId: "okta",
      issuer: "https://your-org.okta.com",
      domain: "yourcompany.com",
      oidcConfig: { clientId: "…", clientSecret: "…" },
  });

  await authClient.signIn.sso({ email: "user@example.com", callbackURL: "/dashboard" });
  ```

  Note the namespace-collision rule, which is good API hygiene for us too: an SSO `providerId` "must not collide with a configured social provider, an `accountLinking.trustedProviders` entry, or a reserved built-in id (e.g. `credential`). Registration is rejected (422) otherwise, since SSO provider ids share the account-linking provider namespace and a collision could otherwise inherit trust meant for that provider."

### 2.3 Account linking across providers

Linking is a first-class, defaulted-on behavior keyed on verified email, with the dangerous variants named and opt-in:

```ts title="auth.ts"
export const auth = betterAuth({
    account: {
        accountLinking: {
            enabled: true,                              // default true
            disableImplicitLinking: false,              // reject same-email auto-link instead
            trustedProviders: ["google", "github"],      // link even without a verified-email signal
            allowDifferentEmails: false,
            allowUnlinkingAll: false,
            updateUserInfoOnLink: false,
        }
    },
});
```

Rules, verbatim-ish from `/docs/concepts/users-accounts`:

- Implicit link happens when an OAuth sign-in's email matches an existing user **and** (the provider verified the email **or** the provider is in `trustedProviders`).
- `trustedProviders` carries an explicit warning: "Use this with caution as it may increase the risk of account takeover."
- `disableImplicitLinking: true` turns the silent link into an `account_not_linked` error — "Use this when you want users to confirm linking from a settings page rather than implicitly on sign-in."
- Explicit linking is `authClient.linkSocial({ provider, callbackURL })`, and the *same* call with `scopes: [...]` is how you do incremental authorization. "Newly granted scopes are merged into `account.scope`, so prior grants survive."
- Linking never rebinds identity: "The user's `email` and `emailVerified` are never changed on a link, so linking a provider can't rebind the account's identity."
- Unlink takes the **local account row id**, never a provider id — and the API refuses to leave a user with zero credentials unless `allowUnlinkingAll`.

There's also a hard-won selector rule we should copy wholesale for any token-returning method: "A `providerId` is never an account selector, and a request without either supported selector is invalid." Callers must pass `accountId` (the local row id) or `useAccountCookie: true`.

---

## 3. Session & account model

### 3.1 The four-table split (verbatim field lists, from `packages/core/src/db/get-tables.ts`)

| Table | Fields |
| --- | --- |
| `user` | `id`, `name` (req), `email` (req, unique), `emailVerified` (bool, req), `image`, `createdAt` (req), `updatedAt` (req) |
| `session` | `id`, `expiresAt` (req), `token` (req, unique), `createdAt` (req), `updatedAt` (req), `ipAddress`, `userAgent`, `userId` → `user.id` (req) |
| `account` | `id`, `accountId` (req), `providerId` (req), `userId` → `user.id` (req), `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `password`, `createdAt` (req), `updatedAt` (req) |
| `verification` | `id`, `identifier` (req), `value` (req), `expiresAt` (req), `createdAt` (req), `updatedAt` (req) |

**Why the split matters (and this is the part that generalizes even though the tables don't):**

- `user` is the *person*, and it is the only thing app code should hold a foreign key to. It contains no credentials at all.
- `account` is **one authentication method**, not one provider. "An account represents one authentication method linked to a user." Email/password is an account row too: "Credential accounts use the `credential` provider ID and the linked user's stable `id` as `accountId`." So password and Google are the same shape, which is exactly why `linkSocial` / `setPassword` / `unlinkAccount` can be uniform verbs.
- **Two distinct identifiers, never conflated.** `id` identifies the local row; `(providerId, accountId)` identifies the external identity. Every account-scoped API takes the local `id`. This is the discipline that makes "same email at two IdPs" and "same IdP twice with different scopes" both expressible.
- Tokens live on `account`, per-method, with their own expiries — so `getAccessToken` can transparently refresh: "If its access token is expired, Better Auth refreshes it before returning it."
- `verification` is a generic single-use token store (`identifier` → `value`), reused by email verification, password reset, magic link, and delete-account confirmation. One mechanism, many features.
- `session` rows carry `ipAddress`/`userAgent`, which is what makes `listSessions` / `revokeSession` / `revokeOtherSessions` a user-visible device list rather than an admin-only concept.

### 3.2 Server-side vs client-side session reads

Two different ergonomics for two different places, and they are *named differently on purpose*:

```ts title="server.ts"
// server: explicit, stateless, you hand it the headers
import { auth } from "./auth";
import { headers } from "next/headers";

const session = await auth.api.getSession({
    headers: await headers() // you need to pass the headers object.
})
```

```tsx title="user.tsx"
// client: reactive store, no arguments
import { authClient } from "@/lib/auth-client"

export function User(){
    const {
        data: session,
        isPending, //loading state
        error,     //error object
        refetch    //refetch the session
    } = authClient.useSession()
}
```

Plus a non-reactive client read (`authClient.getSession()`) for imperative code, and SSR hydration to kill the loading flash:

```tsx
authClient.hydrateSession(initialSession)
const { data, isPending, isRefetching } = authClient.useSession()
const session = isPending && !isRefetching ? initialSession : data
```

Server API calls are *plain function calls that happen to be endpoints* — "Better Auth API endpoints are built on top of better-call, a tiny web framework that lets you call REST API endpoints as if they were regular functions and allows us to easily infer client types from the server." And notably: "**Server-side requests made using `auth.api` aren't affected by rate limiting.** Rate limits only apply to client-initiated requests." That trust boundary — same function, different enforcement depending on whether it came over the wire — is directly relevant to us, since in AWS Blocks *every* API method is internet-reachable and we do **not** get that distinction for free.

### 3.3 The session performance ladder (and its honest caveat)

1. DB read per `getSession` (default).
2. `session.cookieCache` — a second signed `session_data` cookie, 3 strategies (`compact` base64url+HMAC, `jwt` HS256, `jwe` encrypted), with a size/security/interop table in the docs.
3. `secondaryStorage` (Redis-ish `get/getAndDelete/increment/set/delete`).
4. Fully stateless (no DB).

The caveat is stated plainly rather than buried, which is the doc pattern to copy:

> "When `cookieCache` is enabled, revoked sessions may remain active on other devices until the cookie cache expires (`maxAge`)… If immediate session revocation is critical: disable `cookieCache` entirely, or set a shorter `maxAge` (e.g. 60 seconds), or use `disableCookieCache: true` for sensitive operations."

And for the stateless tier they ship the only honest answer to global invalidation — a version bump:

```ts
session: { cookieCache: { version: "2" } } // Change the version to invalidate all sessions
```

### 3.4 Session *freshness* as a first-class concept

`session.freshAge` (default 1 day) gates sensitive endpoints (e.g. `deleteUser` without a password). This is a small, cheap, high-value primitive we currently lack a name for.

---

## 4. The plugin model

### 4.1 What a plugin may extend

The only required field is `id`:

```ts title="plugin.ts"
import type { BetterAuthPlugin } from "better-auth";

export const myPlugin = () => {
    return {
        id: "my-plugin",
    } satisfies BetterAuthPlugin
}
```

A plugin can then supply any of: `endpoints`, `schema`, `hooks` (`before`/`after` with a `matcher`), `middlewares` (API-request-only), `onRequest`/`onResponse`, `rateLimit` rules, and `trustedOrigins`. Docs summary:

> - Create custom `endpoint`s to perform any action you want.
> - Extend database tables with custom `schemas`.
> - Use a `middleware` to target a group of routes using its route matcher…
> - Use `hooks` to target a specific route or request…
> - Use `onRequest` or `onResponse`…
> - Create a custom `rate-limit` rule.

Endpoints:

```ts title="plugin.ts"
import { createAuthEndpoint } from "better-auth/api";

const myPlugin = () => ({
    id: "my-plugin",
    endpoints: {
        getHelloWorld: createAuthEndpoint("/my-plugin/hello-world", { method: "GET" },
            async (ctx) => ctx.json({ message: "Hello World" }))
    }
} satisfies BetterAuthPlugin)
```

Schema, including *adding columns to core tables* with automatic type propagation:

```ts title="plugin.ts"
const myPlugin = () => ({
    id: "my-plugin",
    schema: {
        user: { fields: { age: { type: "number" } } },
    },
} satisfies BetterAuthPlugin)
```

> "This will add an `age` field to the `user` table and all `user` returning endpoints will include the `age` field and it'll be inferred properly by typescript."
> With the matching guardrail: "Don't store sensitive information in the `user` or `session` table. Create a new table if you need to store sensitive information."

Reusable middlewares shipped for the boring-but-critical checks — `sessionMiddleware`, `requireResourceOwnership({ model, idParam, idSource })`, `requireOrgRole({ orgIdParam, allowedRoles })`. Authorization as composable `use: [...]` rather than hand-rolled per endpoint.

### 4.2 How types flow server → client

Entirely by **type-only import**. There is no codegen step and no runtime coupling:

```ts title="client-plugin.ts"
import type { BetterAuthClientPlugin } from "better-auth/client";
import type { myPlugin } from "./plugin";

const myPluginClient = () => ({
    id: "my-plugin",
    $InferServerPlugin: {} as ReturnType<typeof myPlugin>,
} satisfies BetterAuthClientPlugin)
```

> "The client infers the `path` as an object and converts kebab-case to camelCase. For example, `/my-plugin/hello-world` becomes `myPlugin.helloWorld`."

Client plugins may additionally contribute `getActions($fetch)` (imperative methods), `getAtoms($fetch)` (nanostores → framework hooks like `useSession`), `pathMethods`, and `fetchPlugins`. The convention for actions is stated as a guideline: one argument plus optional `fetchOptions`, returning `{ data, error }`.

Core types are inferred the same way on both sides:

```ts
export type Session = typeof authClient.$Infer.Session   // client
type Session = typeof auth.$Infer.Session                 // server
```

…and when server and client live in one repo, `inferAdditionalFields<typeof auth>()` carries user-schema extensions across. The documented limitation is instructive: "When your server and client code are in separate projects… and you cannot import the `auth` instance as a type reference, type inference for custom session fields will not work on the client side."

### 4.3 Worked example: what "a plugin" actually feels like (2FA)

Server: one array entry. Database: one CLI command. Client: one array entry. Then a namespaced method group appears:

```ts title="auth.ts"
export const auth = betterAuth({
    appName: "My App", // used as the TOTP issuer
    plugins: [ twoFactor() ]
})
```
```ts title="auth-client.ts"
const authClient = createAuthClient({
    plugins: [ twoFactorClient({ twoFactorPage: "/two-factor" }) ]
})
```
```ts
await authClient.twoFactor.enable({ password })
await authClient.twoFactor.verifyTOTP({ code: "123456", trustDevice: true })
```

The interesting DX detail is how the plugin changes an *existing* flow without changing its signature: `signIn.email` starts returning a sentinel rather than a session.

> "When a user with 2FA enabled tries to sign in via email, username, or phone number, the response object will contain `twoFactorRedirect` set to `true` and `twoFactorMethods` — an array of the 2FA methods available for the user."

…handled either per-call (`onSuccess`), globally (`onTwoFactorRedirect`), or by config (`twoFactorPage`). And they document the sharp edge honestly: "the pending session is discarded and `ctx.context.newSession` is reset to `null`… Server-side hooks… must null-check it before accessing `newSession.user`."

Magic link is the same shape with the send side injected by the app:

```ts title="server.ts"
export const auth = betterAuth({
    plugins: [
        magicLink({
            sendMagicLink: async ({ email, token, url, metadata }, ctx) => {
                // send email to user
            }
        })
    ]
})
```

Note the *inversion of control for side effects*: better-auth never owns email delivery. Same for `emailVerification.sendVerificationEmail`, `emailAndPassword.sendResetPassword`, `deleteUser.sendDeleteAccountVerification`. Every one is a callback the app supplies, with the same shape `{ user, url, token }`, and every one carries the same warning ("Avoid awaiting the email sending to prevent timing attacks").

### 4.4 Does an analogous seam make sense for a Building Block?

**Partly — and the honest answer is that we already have two seams and should not invent a third.**

What maps well:

| better-auth plugin capability | AWS Blocks analogue | Verdict |
| --- | --- | --- |
| `endpoints` | app-authored methods inside `ApiNamespace`, or a BB-authored `createApi()` state machine | ✅ already have it; `createApi()` is our `endpoints` |
| client methods + `$InferServerPlugin` | typed import of the backend (`import { api } from 'aws-blocks'`) + the Transferable/client-middleware pattern (`scope.registerClientMiddleware`) | ✅ already have it, and ours is stronger (no `$Infer` gymnastics — real types) |
| `hooks.before/after` on auth paths | no equivalent today | ⚠️ genuine gap; see below |
| `schema` extension of `user`/`session` | **not available** — Cognito owns the user record; custom attributes are user-pool-level and immutable once created | ❌ do not copy |
| plugin-declared `rateLimit` rules | no equivalent; API Gateway/Lambda-level throttling is out-of-band | ⚠️ gap worth a decision |
| composable `use: [sessionMiddleware, requireResourceOwnership(...)]` | `await auth.requireAuth(context)` called by hand inside each method | ⚠️ we have the primitive but not the composition |

Where a seam is genuinely useful for us is **policy callbacks, not code injection**. better-auth's own evolution points at this: the highest-value extension point in the whole library is not the plugin interface, it's `user.validateUserInfo` — a single gate that runs for *every* authentication method:

```ts title="auth.ts"
export const auth = betterAuth({
    user: {
        validateUserInfo: ({ user, source }) => {
            if (!user.email?.endsWith("@example.com")) {
                return {
                    error: "email_not_allowed",
                    errorDescription: "Use your example.com email to sign in",
                };
            }
        },
    },
});
```

> "A gate that decides which identities Better Auth admits. It fires just before a user is created (`create-user`) or a new provider account is linked (`link-account`), for every authentication method (OAuth, OIDC SSO, SAML SSO, email/password, magic link, email OTP, anonymous, SIWE, phone number, admin-created users, and SCIM), including stateless setups… so **policy lives in one place instead of per provider**." It also re-fires on returning provider sign-in with the *fresh* provider claims, which catches "the user's email left the allowed domain."

**Recommendation:** adopt a small number of named, typed callbacks on the unified auth BB's options (`validateUserInfo`-equivalent, `beforeDelete`/`afterDelete`, "on new user") rather than a generic plugin interface. Callbacks synthesize cleanly (they're app code running in the Lambda), they don't need a registration bus, and they don't tempt anyone into extending the Cognito schema at runtime. Reserve a real plugin seam for a later RFC if and when a second team needs to ship an auth extension independently.

---

## 5. What makes it feel simple

Concrete, copyable choices — ordered by how much I think each is worth to us:

1. **One import, one call, one exported constant, with a doc-enforced name.** "Make sure to export the auth instance with the variable name `auth` or as a `default` export." Naming the *variable* is unusual and it works: every later snippet, every framework integration, every plugin doc can say `auth` and be literally correct.
2. **Features are keys, and a key's presence is the enablement.** No `enableX` booleans scattered at the top level; no separate registration call. The exception is `emailAndPassword.enabled: true`, which exists because email/password has options you'd want to write before turning it on.
3. **Sibling keys, not sibling packages.** `emailAndPassword` and `socialProviders` are peers in the same object. A user never decides "which auth library do I install" — they decide "which key do I add". This is exactly the choice we're trying to eliminate between `bb-auth-basic` / `bb-auth-cognito` / `bb-auth-oidc`.
4. **Three tiers of provider config, each a superset of the last:** named provider key → provider helper function → raw generic config (→ and, for multi-tenant, runtime-registered SSO rows). A user starts at tier 1 and never learns tier 3 unless their IdP is weird.
5. **Defaults are opinionated and documented inline.** 7-day sessions with 1-day rolling refresh; 1-day freshness; PKCE on by default ("Defaults to `true`. Disable only for providers that explicitly reject PKCE"); account linking on by default; 8-char minimum password; `scrypt` hashing with the OWASP rationale spelled out. Every default has a *reason* in the doc, which makes the defaults feel chosen rather than accidental.
6. **Method names are verb-first and symmetrical across methods.** `signUp.email` / `signIn.email` / `signIn.social` / `signIn.magicLink` / `signIn.sso` / `signOut`. The namespace is the *verb*, the leaf is the *method*. Adding a mechanism adds a leaf, never a new top-level verb. Plugins get their own namespace (`authClient.twoFactor.*`, `authClient.sso.*`).
7. **Two names for two contexts, not one overloaded name.** `useSession()` (reactive, client) vs `getSession()` (imperative) vs `auth.api.getSession({ headers })` (server). A user is never confused about which environment they're in.
8. **The dangerous option is always the longer name.** `allowDifferentEmails`, `disableImplicitLinking`, `allowUnlinkingAll`, `disableIdTokenNonceBinding`, `trustedProviders`, `disableProviderLogout`. You cannot type the risky thing by accident, and each one carries a warning callout.
9. **Errors are a catalogued, documented vocabulary.** `$ERROR_CODES` is exposed on the client for i18n, and there is a doc page per OAuth error (`account_not_linked`, `state_mismatch`, `email_not_found`, …). Compare our `isBlocksError(e, SomeErrors.Foo)` — same instinct, and we should extend it to a per-error doc page for auth failures specifically, because auth errors are the ones users actually hit.
10. **Zero-config paths degrade rather than fail.** No database → stateless mode. Discovery down → skip that provider, keep serving. Rate limiting off in dev, on in prod.
11. **AI/agent affordances as a first-class docs feature** — `llms.txt`, a `.md` variant of every page, a docs MCP server, and published agent "skills". This is why this research took minutes rather than hours, and it is cheap for us to copy (we already have per-BB `README.md`/`DESIGN.md`; publishing an index is nearly free).

---

## 6. What NOT to copy, given our constraints

| better-auth does | Why we can't / shouldn't | What we do instead |
| --- | --- | --- |
| **Owns four tables and a migration CLI** (`npx auth generate` / `migrate`) | Cognito is the engine. We do not own `user`, and we must not create a shadow user table — AGENTS.md rule 2 says state goes through BBs, and a parallel identity store would diverge from the pool. | Treat the Cognito user pool as the system of record. Any extra profile data belongs in a *separate* BB (`bb-kv-store` / `bb-distributed-table`) keyed by the Cognito `sub`, never in the auth BB's own schema. |
| **`user.additionalFields` / plugin `schema` extending core tables, typed end-to-end** | Cognito custom attributes are declared on the user pool, are **immutable once created** (name, type, mutability, length all fixed), and are capped (50 custom attributes). A `type: ["user","admin"]` enum field with a `defaultValue` cannot be modelled this way, and a field added in code today cannot be renamed tomorrow without replacing the pool. | Expose a *small, closed* set of standard claims on our user type. For app-specific fields, document the "profile in a KV/table BB" pattern explicitly. If we do support custom attributes, they must be declared at the CDK layer, validated as append-only, and we must fail synth loudly on a removal/retype rather than silently replacing the pool. |
| **Runtime provider registration** (`POST /sso/register` writing an IdP row) | An IdP in Cognito is a CloudFormation resource (`AWS::Cognito::UserPoolIdentityProvider`). Creating one at runtime from a public RPC endpoint would mean an SDK write outside CDK's control, drifting from the synthesized template, and it is a privileged operation exposed on an unauthenticated-by-default surface (AGENTS.md rule 9). **We already know how painful even *deploy-time* IdP registration is:** `bb-auth-oidc` has to register IdPs through a Lambda-backed custom resource (CloudFormation forbids `ssm-secure` dynamic references on `UserPoolIdentityProvider.ProviderDetails`), which means the resource carries `Trigger: Date.now().toString()` and "shows as updated on every deploy", the first deploy registers with `bb-app-setting`'s random **placeholder** secret so sign-in fails until the real SecureString is written *and* the stack redeployed, and because `PhysicalResourceId` is `<pool>\|<name>\|<type>`, changing `ProviderName`/`ProviderType` **forces replacement**. | Providers are **synth-time config**. If multi-tenant self-service IdP registration is ever required, it's a separate opt-in BB with its own admin authorization story and an explicit "this resource is managed outside CDK" contract — not the default path. And the unified BB should inherit `bb-auth-oidc`'s hard-won custom-resource machinery rather than re-deriving it. |
| **"Just add a provider key" being a cheap, reversible change** | Several Cognito properties are replace-on-update: `UserPoolName`-driven naming, alias/username attributes, schema, and (depending on shape) app-client settings. Adding a provider is cheap; *changing how users are identified* is not. Our resource names are derived from `fullId` (`fullId.substring(0,255)`), so a rename is a pool replacement — i.e. total user loss. And the landmines are not hypothetical: `bb-auth-cognito`'s CDK layer pins `featurePlan` explicitly because Cognito "re-applies the tier as a side effect on every `UpdateUserPool`, which silently resets `AdminCreateUserConfig.AllowAdminCreateUserOnly` back to `true` (breaking self-signup on every deploy after the first)". | Document a hard "immutable after first deploy" list in the BB's README/DESIGN, and add synth-time guards that fail with an actionable error when an immutable property changes, rather than letting CloudFormation replace the pool. `bb-auth-cognito` already does this well (synth throws for `USER_SRP_AUTH`/`CUSTOM_AUTH`, for `userPoolName` > 128 chars, for `enablePasskeys` without `authFlowType: 'USER_AUTH'` + `webAuthnRelyingParty` + a non-`lite` plan, and for Email MFA on a BB-created pool without SES) — generalize that discipline, don't lose it. This is the single highest-risk difference between us and better-auth and it deserves its own section in the design doc. |
| **A generic plugin interface** (`endpoints`, `middlewares`, `onRequest`, `rateLimit`, `trustedOrigins`) | We already have `ApiNamespace` for endpoints, `RawRoute` as the raw escape hatch, and client middleware for hydration. A third extension mechanism would have to be mirrored across four conditional-export layers (mock/aws/cdk/browser) and kept in parity by `conditional-exports.test.ts`. The cost is real and the demand is currently zero. | Typed option callbacks (see §4.4). Reassess a plugin seam only when a second package needs to extend auth without editing it. |
| **`auth.api.*` being exempt from rate limiting** because it's "server-side" | We have no such distinction: every method on an `ApiNamespace` is a public, internet-reachable RPC endpoint with no auth by default. There is no "trusted internal caller" variant of the same function. | Every method gates itself (`await auth.requireAuth(context)`), and anything resembling an admin operation must be either absent from the RPC surface entirely or gated on an explicit admin check. Do **not** port any better-auth API whose safety argument is "only callable from the server" — e.g. `setPassword`, which better-auth explicitly refuses to expose to clients. |
| **Storing provider tokens in cookies** (`storeAccountCookie`, chunked oversized cookies) | Their own docs warn: "Cognito JWTs can be large; Better Auth chunks oversized account cookies, but browsers and proxies can still enforce total header limits." Add API Gateway/Lambda header limits and this is a latent production failure. Also relevant to us: Lambda env config has a ~4 KB cap, which is why we use `registerConfig()` instead of `addEnvironment()`. | Keep the session cookie small and opaque. Cognito already issues and refreshes tokens; don't re-invent token custody in cookies. |
| **`emailAndPassword.password.hash/verify` (pluggable hashing)** | We don't hash passwords — Cognito does. Exposing a hashing hook would imply we own the credential, which would be actively misleading. | Omit entirely. Password *policy* (length, complexity) is a user-pool property and belongs in the CDK layer. |
| **Mutating provider config asynchronously** (`AwaitableFunction` provider options, discovery at "server startup") | Our CDK layer runs at synth; discovery-at-startup in a Lambda means a cold-start network call to an IdP on the first request, and synth-time discovery means `cdk synth` needs network access and becomes non-deterministic. | Require the issuer/endpoints as explicit config, or resolve discovery **lazily at first use inside the handler with caching** — and never during synth. Mirror this in the mock layer so local dev doesn't need the network at all. |
| **`Error.cause` style rich error chaining from the SDK** | AGENTS.md rule 5: never attach `Error.cause` enumerably — Cognito SDK errors carry `$metadata`, ARNs, and pool ids that must not reach the client. | Map Cognito errors to our own named error constants (rule 6: match by `name`, not `code`) and drop the SDK error. Copy better-auth's *catalogue* idea, not its error plumbing. |
| **`get()`-ish reads that throw for "not found"** | Rule 7: `get()`-style reads return `null`. | `getSession()` returns `null` when unauthenticated; only `requireAuth()` throws. |

---

## 7. Adjacent references, for contrast

*(A parallel review of Amplify Gen2 `defineAuth`, Auth.js v5, and Clerk. Deliberately comparative — the point is which of better-auth's choices are consensus and which are unique. Snippets are verbatim from each project's docs repo / library source; note that none of these three sites serve a `.md` variant the way better-auth does, so these came from `aws-amplify/docs`, `nextauthjs/next-auth`, and `clerk/clerk-docs`.)*

### 7.1 AWS Amplify Gen2 `defineAuth` — the closest existing AWS answer

Top-level keys of `defineAuth`, from the source types (`packages/auth-construct/src/types.ts` → `AuthProps`, extended by `packages/backend-auth/src/factory.ts` → `AmplifyAuthProps`): `name?`, `loginWith`, `senders?`, `userAttributes?`, `multifactor?`, `accountRecovery?`, `groups?`, `passwordlessOptions?`, `triggers?`, `access?`.

The minimal form is genuinely minimal:

```ts title="amplify/auth/resource.ts"
import { defineAuth } from "@aws-amplify/backend"

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
})
```

Named providers + `secret()`:

```ts title="amplify/auth/resource.ts"
import { defineAuth, secret } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: true,
    externalProviders: {
      google: {
        clientId: secret('GOOGLE_CLIENT_ID'),
        clientSecret: secret('GOOGLE_CLIENT_SECRET')
      },
      signInWithApple: {
        clientId: secret('SIWA_CLIENT_ID'),
        keyId: secret('SIWA_KEY_ID'),
        privateKey: secret('SIWA_PRIVATE_KEY'),
        teamId: secret('SIWA_TEAM_ID')
      },
      loginWithAmazon: {
        clientId: secret('LOGINWITHAMAZON_CLIENT_ID'),
        clientSecret: secret('LOGINWITHAMAZON_CLIENT_SECRET')
      },
      facebook: {
        clientId: secret('FACEBOOK_CLIENT_ID'),
        clientSecret: secret('FACEBOOK_CLIENT_SECRET')
      },
      callbackUrls: [
        'http://localhost:3000/profile',
        'https://mywebsite.com/profile'
      ],
      logoutUrls: ['http://localhost:3000/', 'https://mywebsite.com'],
    }
  }
});
```

Generic OIDC is an **array**; SAML is a **singleton**; both live in the same `externalProviders` object as the named keys:

```ts
    externalProviders: {
      oidc: [
        {
          name: 'MicrosoftEntraID',
          clientId: secret('MICROSOFT_ENTRA_ID_CLIENT_ID'),
          clientSecret: secret('MICROSOFT_ENTRA_ID_CLIENT_SECRET'),
          issuerUrl: '<your-issuer-url>',
        },
      ],
      saml: {
        name: 'MicrosoftEntraIDSAML',
        metadata: {
          metadataContent: '<your-url-hosting-saml-metadata>',
          metadataType: 'URL', // or 'FILE'
        },
      },
      logoutUrls: [...], callbackUrls: [...],
    },
```

MFA, senders, recovery and attributes are peers in the same object:

```ts
export const auth = defineAuth({
  loginWith: { email: true },
  multifactor: { mode: 'OPTIONAL', totp: true, email: true },
  senders: { email: { fromEmail: 'noreply@example.com', fromName: 'My App' } },
  accountRecovery: "EMAIL_AND_PHONE_WITHOUT_MFA",
  userAttributes: { phoneNumber: { required: true } }
});
```

Groups, triggers, and IAM grants — note `triggers` takes a **resource reference**, not an inline closure, and `access` is a capability grammar:

```ts
import { defineAuth } from "@aws-amplify/backend";
import { postConfirmation } from "./post-confirmation/resource"

export const auth = defineAuth({
  loginWith: { email: true },
  groups: ["EVERYONE"],
  triggers: { postConfirmation },
  access: (allow) => [ allow.resource(postConfirmation).to(["addUserToGroup"]) ],
})
```

**What it gets right, and we should match or beat:**

- **One `defineAuth({...})` call with `loginWith` as the single enablement surface.** `email: true` and `externalProviders` are siblings — same instinct as better-auth's `emailAndPassword` + `socialProviders`. `loginWith` correctly models *sign-in methods as a closed set* rather than a provider array. This is the strongest evidence that the single-object shape is right *in an AWS/Cognito context specifically*, not just for a table-owning library.
- **`secret('NAME')` as a name-only, environment-resolved reference.** You run `npx ampx sandbox secret set foo` once and write `clientId: secret('foo')`; the docs state "Depending on your environment, Amplify will automatically load the correct secret value with no extra configuration." Strictly better than better-auth's `process.env.X as string` — and that `as string` is a cast we're forbidden from shipping anyway (AGENTS.md rule 8).
- **`access: (allow) => [ allow.resource(fn).to([...]) ]`** — a capability grammar for who may call which auth admin action. better-auth has no analogue because it provisions nothing. Our `AdminActionGate<O, A>` phantom-tuple approach in `bb-auth-cognito` is solving the same problem more cleverly but less legibly; worth comparing deliberately.
- **`attributeMapping` per provider** — the Cognito-native equivalent of `mapProfileToUser`, declared at synth time and enforced by Cognito rather than by our Lambda.
- **Lifecycle extension is Lambda triggers** (`preSignUp`, `postConfirmation`, `preTokenGeneration`, …) declared in the same object. The Cognito-native form of better-auth's hooks, and the seam we actually have available.
- **`groups: ["EVERYONE"]` as plain strings** — the simplest thing that works, and it's what we already do.

**What it gets wrong, and we should explicitly avoid:**

- **No offline/mock mode for auth.** `npx ampx sandbox` creates a real CloudFormation stack (`amplify-<app>-<whoami>-sandbox`) and hot-swaps on change. Gen2 **removed** Gen1's `amplify mock`, and even that only mocked API/Storage/Functions — its JWT mocking still required "`amplify push` first to create the User Pool." Every auth config iteration is a cloud round trip. **This is our single biggest differentiation opportunity:** our mock layer makes `signIn`/`signUp`/`confirmSignIn` work with zero AWS account, and conditional exports make the mock the *default* resolution (`"types"` and `"default"` both point at it).
- **No type flow from the backend definition to the client.** The backend emits runtime JSON (`amplify_outputs.json`); `aws-amplify/auth` is typed against the *library*, not your config. The `nextStep.signInStep` discriminated union is identical whether or not you enabled MFA, so the compiler cannot tell you which branches are reachable:

  ```ts
  const { nextStep } = await signIn({ username: "hello@mycompany.com", password: "hunter2" });
  if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_SMS_CODE" || ...) {
    await confirmSignIn({ challengeResponse: "123456" });
  }
  ```

  And a custom provider is an unchecked string that must match the backend's `name` by hand:

  ```ts
  await signInWithRedirect({ provider: { custom: 'MicrosoftEntraID' } });  // custom OIDC/SAML
  await signInWithRedirect({ provider: 'Apple' });                          // built-in
  ```

  The damning detail: **Amplify's own `defineData` does flow types**, via `generateClient<Schema>()`. Auth simply never got the same treatment. For us, "the frontend imports the backend's types" is the headline feature — so provider ids and reachable next-steps *must* be unions derived from the config. This is the gap all three references leave open and the one an Infrastructure-from-Code framework is uniquely positioned to close.
- **Immutability is documented as prose, never as a type or a synth error.** From the concepts page: "Sign-in methods (including username, email, and phone) cannot be added or changed after the initial configuration… Required attributes must have a value for all users once set." From the sandbox setup page: "**Amazon Cognito User Pool Changes:** Unsupported modifications, such as deleting a required field, result in Amplify dropping and recreating the user pool." All users gone, from what reads like a normal edit. And adding your first external provider can require a two-deploy dance — the `domainPrefix` docstring: *"If you need to update this in the future, you must first unset it, then deploy the change to remove the domain from the UserPool. After the domain has been removed, you can then provide a new value, and perform another deployment."* **This is the highest-severity concrete failure in the prior art and the thing we must beat.**
- **CDK types leak into the "clean" public surface.** `OidcProviderProps = Omit<cognito.UserPoolIdentityProviderOidcProps, 'userPool' | 'attributeRequestMethod' | 'attributeMapping'> & {…}`; SAML likewise wraps `UserPoolIdentityProviderSamlProps`. So the autocomplete is really Cognito L2 minus three fields — directly at odds with our rule against leaking AWS primitives in public signatures.
- **Cognito-shaped naming rather than domain-shaped.** `signInWithApple` / `loginWithAmazon` (vendor marketing names as keys), `multifactor` (not `mfa`), and `custom:` prefixes in user code:

  ```ts
    userAttributes: {
      "custom:display_name": { dataType: "String", mutable: true, maxLen: 16, minLen: 1 },
      "custom:favorite_number": { dataType: "Number", mutable: true, min: 1, max: 100 },
    },
  ```
- **`oidc` is an array but `saml` is a singleton** — one Cognito limit surfacing as an inconsistent API. (We have the same latent issue: Cognito allows one IdP per `ProviderName` per pool, which `bb-auth-oidc` already enforces by throwing at synth when two `cognitoFederated()` configs share an `identityProvider`. Enforce it; don't let it distort the shape.)
- **The escape hatch is a cliff, not a ramp.** Untyped CloudFormation property strings from a *different file* (`backend.ts`):

  ```ts
  const backend = defineBackend({ auth });
  const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
  cfnUserPool.addPropertyOverride(
  	'Policies.SignInPolicy.AllowedFirstAuthFactors',
  	['PASSWORD', 'WEB_AUTHN', 'EMAIL_OTP', 'SMS_OTP']
  );
  ```

  Compare better-auth's graduated `getUserInfo` / `getToken` / `authorizationUrlParams`. Our BB should offer *typed* escape hatches before dropping users to raw overrides.
- **Existing resources are a whole separate factory**, not an option: `referenceAuth({ userPoolId, identityPoolId, authRoleArn, unauthRoleArn, userPoolClientId })`. That's a second API to learn and a second code path to maintain. Our `fromExisting()` → reference-object → constructor-option pattern (already in `bb-auth-cognito` via `options.userPool`) is better; keep it.
- **Attribute-mapping footgun surfaced only as a Callout:** "a mapping must be present for each attribute that your user pool requires… you must also ensure that the target of each attribute mapping is mutable. If these criteria are not met, Amazon Cognito will return an error and the sign in attempt will fail." A runtime sign-in failure caused by synth-time config is exactly what a synth-time check is for.
- **Two disjoint vocabularies.** Backend says `loginWith.email`; client says `signIn({ username, password })`. Backend says `externalProviders.google`; client says `signInWithRedirect({ provider: 'Google' })` — capital G, different string space. better-auth uses the *same* id on both sides (`socialProviders.github` → `signIn.social({ provider: "github" })`). Copy better-auth here.
- Minor but telling: MPA redirect handling requires a **side-effect import as API** — `import 'aws-amplify/auth/enable-oauth-listener'` on the success page.

### 7.2 Auth.js / NextAuth v5 — providers as an array of values

The destructured return *is* the integration surface — handlers, server helper, and actions all from one call:

```ts title="./auth.ts"
import NextAuth from "next-auth"

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [],
})
```

A named provider is passed **bare**, with `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` inferred from the environment by convention:

```ts title="@/auth.ts"
import NextAuth from "next-auth"
import Google from "next-auth/providers/google"

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
})
```

Overrides deep-merge into the built-in defaults, so small overrides stay small: *"they will be deeply-merged with our defaults. That means you only have to override part of the options… if you want different scopes, overriding `authorization.params.scope` is enough, instead of the whole `authorization` option."*

```ts title="./auth.ts"
providers: [
  Auth0({ authorization: { params: { scope: "openid custom_scope" } } }),
],
```

A fully custom OIDC provider is a **plain object literal in the same array** — no factory, no registration step, no second mechanism:

```ts title="./auth.ts"
export const { handlers, auth } = NextAuth({
  providers: [{
    id: "my-provider", // signIn("my-provider") and will be part of the callback URL
    name: "My Provider", // optional, used on the default login page as the button text.
    type: "oidc", // or "oauth" for OAuth 2 providers
    issuer: "https://my.oidc-provider.com", // to infer the .well-known/openid-configuration URL
    clientId: process.env.AUTH_CLIENT_ID, // from the provider's dashboard
    clientSecret: process.env.AUTH_CLIENT_SECRET, // from the provider's dashboard
  }],
});
```

**This is the cleanest provider normalization of the four,** because built-ins and custom providers are *literally the same type* (`packages/core/src/providers/oauth.ts`):

```ts
export interface OAuth2Config<Profile> extends CommonProviderOptions, PartialIssuer {
  id: string
  name: string
  /** OpenID Connect (OIDC) compliant providers can configure
   * this instead of `authorize`/`token`/`userinfo` options … */
  wellKnown?: string
  issuer?: string
  authorization?: string | AuthorizationEndpointHandler
  token?: string | TokenEndpointHandler
  userinfo?: string | UserinfoEndpointHandler
  type: "oauth"
  /** Receives the full {@link Profile} returned by the OAuth provider, and returns a subset.
   * It is used to create the user in the database.
   * Defaults to: `id`, `email`, `name`, `image` */
  profile?: ProfileCallback<Profile>
  account?: AccountCallback
  /** @default ["pkce"] */
  checks?: Array<"pkce" | "state" | "none">
  clientId?: string
  clientSecret?: string
  style?: OAuthProviderButtonStyles
  allowDangerousEmailAccountLinking?: boolean
  options?: OAuthUserConfig<Profile>
}

export interface OIDCConfig<Profile> extends Omit<OAuth2Config<Profile>, "type" | "checks"> {
  type: "oidc"
  checks?: Array<NonNullable<OAuth2Config<Profile>["checks"]>[number] | "nonce">
  idToken?: boolean
}
```

Credentials are the same idea — declare the fields, own the verification:

```ts title="./auth.ts"
Credentials({
  credentials: { email: {}, password: {} },
  authorize: async (credentials) => {
    let user = null
    const pwHash = saltAndHashPassword(credentials.password)
    user = await getUserFromDb(credentials.email, pwHash)
    if (!user) throw new Error("Invalid credentials.")
    return user
  },
}),
```

**Better than better-auth:** no named-vs-generic split at all — `Google` is just a function returning `OIDCConfig`, and every field is overridable by the same mechanism. better-auth has the *same two-tier gap Amplify does* (`socialProviders` keys vs a `genericOAuth` plugin); Auth.js doesn't. Also: provider entries are inspectable, composable *values* (map/filter/build per tenant).

**Worse than better-auth:**

- **An array loses key-based identity.** "Is Google configured?" and "disable this provider" require a scan; duplicate ids are a runtime concern; every entry restates its `id`; and "which sign-in methods are enabled" is a runtime question rather than a typed one.
- **Account linking is off by default and named after the risk.** *"Normally, when you sign in with an OAuth provider and another account with the same email address already exists, the accounts are not linked automatically. Automatic account linking on sign in is not secure between arbitrary providers and is disabled by default… Set `allowDangerousEmailAccountLinking: true`"*, and when it does happen: *"Linking Accounts(s) to User(s) happen automatically, only when they have the same e-mail address, **and the user is currently signed in**."* Auth.js's naming is more honest; better-auth's `accountLinking.trustedProviders` is more usable with the same security property. **We should take better-auth's shape with Auth.js's honesty in the JSDoc.**
- **`profile()` conflates identity and profile** — `id` comes out of the same callback that maps `name`/`email`. better-auth's split (`accountSubject` separate, `OAuth2UserInfo` with `id?: never`) is a strict improvement.
- **Two session strategies with different capabilities.** JWT (default, no DB) vs database; the documented costs are *"Expiring a JSON Web Token before its encoded expiry is not possible - doing so requires maintaining a server-side blocklist"* and *"Many database adapters are not yet compatible with the Edge."* better-auth's cookie-cache ladder is a smoother continuum than a binary strategy switch.
- **Config is spread across four places** — the object, `callbacks`, env-var naming conventions, and the adapter — so "where does X go?" has several answers.
- Nothing is provisioned, so there is no story for infra, secrets, or drift.
- Adapter schema is the same four models (`User`, `Account`, `Session`, `VerificationToken`) — confirming that split is genuine consensus, not a better-auth invention.

### 7.3 Clerk — config in a dashboard, not in code

**Provider config is not in code at all.** Adding Google is a dashboard flow ("navigate to the **SSO connections** page. Select **Add connection**… Select the provider"), and even custom OIDC is dashboard-only: **Name**, **Key** (*"cannot be changed after creation"*), **Discovery Endpoint**, **Client ID**, **Client Secret**, a **Use PKCE** toggle, and an **Attribute mapping** panel. When mapping isn't enough, the escape hatch is *a deployed HTTP service*: "you should implement a proxy between Clerk and the provider… The proxy will then be set as the **User info URL**."

Clerk is now retrofitting config-as-code — as a CLI patching hosted state, not a config file:

```
npx clerk@latest config patch --json '{"connection_oauth_<provider>":{"enabled":true}}'
npx clerk@latest config schema
npx clerk@latest api enterprise_connections/<id> -X PATCH -d '{"saml":{"allow_subdomains":true}}'
```

Telling detail: those commands are documented inside `<If is="llm">` blocks — **added specifically for AI agents**. A direct admission that dashboard-only config is a liability in an agentic workflow. That's a strong argument for our config-as-code position generally, and for keeping the unified BB's options object legible to an agent reading `README.md`.

The API surface is uniformly wide and statically typed precisely *because* there is nothing to infer from:

```tsx
import { currentUser } from '@clerk/nextjs/server'
export default async function Page() {
  const user = await currentUser()
  if (!user) return <div>Not signed in</div>
  return <div>Hello {user?.firstName}</div>
}
```
```tsx
'use client'
import { useUser } from '@clerk/nextjs'
export default function Page() {
  const { isSignedIn, user, isLoaded } = useUser()
  if (!isLoaded) return <div>Loading...</div>
  if (!isSignedIn) return <div>Sign in to view this page</div>
  return <div>Hello {user.id}!</div>
}
```

**The one thing most worth stealing:** `auth.protect()` — a single gating primitive whose failure modes are a documented truth table. Authenticated + authorized → the `Auth` object; authenticated + **un**authorized → **404** (not 403, deliberately, to avoid leaking existence); unauthenticated → redirect to sign-in (401 for Server Actions, 404 for other session-token requests). It accepts `{ role, permission, has, unauthorizedUrl, unauthenticatedUrl, token }`. Compare our `await auth.requireAuth(context)`: same instinct, but we have not written down the truth table, and we have no role/permission argument. Both are cheap to add.

**What the hosted model buys:** nothing to deploy or migrate; provider changes take effect instantly with **no replacement risk** — the exact class of failure that bites Amplify; and dev instances ship *"pre-configured, shared credentials"* so social sign-in works before you own any OAuth app.

**What it costs:** config isn't in git, isn't reviewable in a PR, doesn't branch with your code, can't be diffed between environments. The custom-OIDC **Key** is immutable anyway — so you inherit Amplify's immutability problem *without* the audit trail. No local/offline story; `currentUser()` even carries a rate-limit warning ("For optimal performance and to avoid rate limiting, it's recommended to use `useUser()` on the client-side when possible"). And you cannot express "this app has exactly these sign-in methods" as a type.

### 7.4 Contrast table

| Dimension | better-auth | Auth.js v5 | Clerk | Amplify Gen2 |
| --- | --- | --- | --- | --- |
| Config location | one code object | one object + `callbacks` + env conventions + adapter | hosted dashboard; `clerk config pull/patch` retrofits CLI access | one code object in `amplify/auth/resource.ts` |
| Provider collection shape | keyed record (`socialProviders.google`) | array of provider **values** | dashboard list | keyed record + `oidc[]` array + `saml` singleton |
| Named vs generic | two mechanisms, identical call site | **one type, no split** ✅ | dashboard "custom OIDC"; identity is an immutable **Key** | four named keys (each a distinct `Omit<cdk…>` type) vs `oidc[]` — hard two-tier gap |
| Generic-OIDC expressiveness | `discoveryUrl` + full endpoint/`getToken`/`getUserInfo` override table | **most expressive**: `wellKnown`/`authorization`/`token`/`userinfo`/`profile` | least: non-standard claims need a **deployed proxy** | `{ name, clientId, clientSecret, issuerUrl }`, second-class |
| Secrets | `process.env.X as string` | convention env vars (`AUTH_*_ID`) | env keys only | **`secret('NAME')`, environment-resolved** ✅ |
| Local dev / mock | runs anywhere; stateless mode; SQLite | **best**: pure library, offline, DB optional | none; always hits Clerk's API (rate-limited) | **worst**: no mock; `ampx sandbox` = real CloudFormation; Gen1's `amplify mock` removed |
| Type flow server→client | type-only import (`$Infer`, `$InferServerPlugin`) — **only one of the four where enabling a method changes client types** | none (but `{ handlers, auth, signIn, signOut }` is config-derived) | impossible — config isn't in the type graph | **none**; `nextStep` union unaffected by config; `provider: { custom: 'X' }` unchecked |
| Extensibility seam | plugins (endpoints/schema/hooks/rate-limit) | `profile()`/`account()`/`callbacks`, custom adapter | dashboard toggles, JWT templates, HTTP proxy, Backend API | `triggers` (Lambda refs) + `access: (allow) => …` + L1 `addPropertyOverride()` |
| Account linking | on by default, verified-email gate, `trustedProviders` | off by default, per-provider `allowDangerousEmailAccountLinking` | first-class, dashboard-configured | Cognito `attributeMapping`; a required-but-unmapped/immutable attribute makes **sign-in fail at runtime** |
| Gating primitive | `auth.api.getSession({ headers })` + hand-rolled checks | `auth()` + middleware | **`auth.protect({ role, permission })` with a documented truth table** ✅ | `fetchAuthSession()` / `getCurrentUser()` |
| Error vocabulary | `$ERROR_CODES` + a doc page per error ✅ | typed error classes | HTTP + dashboard logs | SDK exception names |
| Immutability handling | n/a (owns its schema) | n/a | Key immutable, but no resource replacement | **prose warnings only; silent user-pool replacement** ❌ |

---

## 8. Mapping table: better-auth → AWS Blocks / Cognito → gap

### 8.0 Where we stand today (so the "gap" column means something)

A survey of `packages/bb-auth-basic`, `packages/bb-auth-cognito`, `packages/bb-auth-oidc`, and `packages/auth-common` at HEAD. The governing decisions are `docs/DECISIONS.md` **D-004** (auth-first naming) and **D-005** (unified form model, no redirect action type).

**The good news: we are further along than this document's framing implies.** Several of better-auth's best ideas already exist here, they're just unevenly distributed:

- **`bb-auth-oidc` already has better-auth's provider abstraction**, and arguably a better one. `packages/bb-auth-oidc/src/types.ts` defines a `kind`-discriminated union over `ProviderConfigBase` with named factories in `providers.ts` (`google`, `github`, `stubIdp`, `customOidc`, `customOauth2`, `cognitoFederated`) — i.e. better-auth's "named provider → provider helper → raw generic config" tiering, already built:

  ```ts
  export type ProviderKind = 'oidc-builtin' | 'oidc-custom' | 'oauth2-custom' | 'stub' | 'cognito-federated';
  export interface ProviderConfigBase {
  	readonly name: string; readonly kind: ProviderKind;
  	readonly clientId: SecretLike; readonly clientSecret: SecretLike; readonly scopes: readonly string[];
  }
  export type SecretLike = string | (() => string | Promise<string>);
  export type ProviderName<P extends readonly ProviderConfig[]> = P[number]['name'];
  ```
- **`SecretLike` is our `secret()`, and it's better than Amplify's** — a thunk resolved at use time rather than a name resolved by a CLI, with `memoizedSecretResolver` (failures deliberately not memoized) and an `AppSettingLike` variant for `cognitoFederated()` so the CDK layer can read `.fullId`. Recommendation #5 below is therefore *standardize what exists*, not *invent*.
- **`ProviderName<P>` already gives config-derived literal provider names on the client** (via `createApi()` → `getClient()` → `OIDCClient<ProviderName<P>>`), and `AuthCognito<const O>` already derives attribute/group unions from options (`ReadAttrOf<O>`, `GroupOf<O>`). **This is the exact type-flow gap all four references leave open, and we have already closed it in two BBs.** Unification must not lose it.
- **MFA is already a key, not a plugin** (`mfa: 'off' | 'optional' | 'required'`, `mfaTypes: ('SMS'|'TOTP'|'EMAIL')[]`) — confirming the §4.4 conclusion that Cognito features belong in the options object.
- **Synth-time immutability guards already exist** in `bb-auth-cognito` (throws for `USER_SRP_AUTH`/`CUSTOM_AUTH` at *both* synth and runtime as defence-in-depth against a `fromExisting` bypass; for `userPoolName` > 128 chars; for `enablePasskeys` without `authFlowType: 'USER_AUTH'` + `webAuthnRelyingParty` + a non-`lite` plan; for Email MFA on a BB-created pool without SES). This is precisely what Amplify lacks.
- **`auth-common/src/cookies.ts` is itself a drift post-mortem** and documents the pattern to follow: *"Historically each auth BB hand-rolled its own `SameSite`/`Secure`/`Partitioned` selection. They drifted: basic and cognito defaulted to `SameSite=None` … while oidc defaulted to `SameSite=Lax`."*

**The bad news — the concrete divergences unification has to resolve:**

| Axis | `AuthBasic` | `AuthCognito` | `AuthOIDC` |
| --- | --- | --- | --- |
| Layer layout | `index.ts` + `index.browser.ts` only (composite BB, infra delegated to `KVStore` ×2 + `AppSetting`; rationale D-AB-8) | `index.ts` (=mock) + `.aws` + `.cdk` + `.browser`, no file literally named `index.mock.ts` | abstract base `auth-oidc.ts` + `.mock` + `.aws` + `.cdk` + `.browser` (a real 500-line PKCE client) |
| Required options | none | none | **`providers` — the only required option in the family** |
| Federation | none | **none — `disableOAuth: true`, "the hosted UI is never used"; DESIGN.md: "HostedUI + federated sign-in … not supported"** | all of it, incl. `cognitoFederated()` which provisions its *own* second user pool |
| Session | HS256 JWT *as* the cookie value; stateless; **cannot revoke individual sessions** | `<sessionId>.<hmac>` → `KVStore` row holding id/access/refresh tokens | `v1.<payload>.<sig>` envelope → `KVStore` row with CAS refresh + a separate `_pending` cookie |
| User type | `AuthBasicUser extends AuthUser` (`+createdAt`); `userId` = username | `CognitoUser<O> extends AuthUser` (`+attributes`, `+groups`, `+userSub`); `userId` = Cognito `sub` | `OIDCUser` — **not declared `extends AuthUser`**, only structurally compatible; `userId` = `` `${iss}:${sub}` `` |
| `createApi()` | `{ getAuthState, setAuthState }`, return type *inferred* | `{ getAuthState, setAuthState }`, typed `AuthStateApi` | `{ getAuthState, setAuthState, getClient }` — **a third method** |
| State machine | 4 states inlined in `index.ts` | dedicated 615-line `state-machine.ts`, 7 builders | 2 states inlined; `setAuthState` handles exactly one action (`signOut`) and returns `"Unknown action: …"` for the rest |
| Error names for the same condition | `SessionExpiredException`, `UserAlreadyExistsException`, `InvalidCodeException` (5 total) | `NotAuthenticatedException`, `UsernameExistsException`, `CodeMismatchException`/`ExpiredCodeException` (29, mirroring wire names) | `NotAuthenticatedException` + `TokenExpiredException` (8) |
| Password policy field | `requireSpecialChars` | `requireSymbols` | n/a |
| `CodeDeliveryFn` | 2-arg | 3-arg (`purpose`) | n/a |
| Cookie plumbing | own **unanchored, unescaped** regex read (a `RegExp` built by interpolating the cookie name directly, with no anchor and no metachar escaping) — the prefix-collision bug Cognito's `cookies.ts` explicitly fixed | own name builder + HMAC + anchored read + a second encrypted auto-sign-in cookie | own `buildSetCookie`/`buildClearCookie`/`readCookie` + versioned envelope; hard-codes `isLocalhost: true` at construction in the mock |
| Lifecycle hooks | none | none | `onSignIn` / `onSignOut` |
| Typed UI overrides | none | `src/ui.ts` (`cognitoOverrides()`, exposed as a `./ui` subpath), with a "Keep in lockstep with `state-machine.ts`" comment | none |

Two structural problems worth calling out before the table:

1. **The shared UI contract is already Cognito's vocabulary.** `auth-common/src/ui.ts`'s `AuthActionPayloadMap` carries 8 `confirmSignIn` challenge variants, passkey actions, and `autoSignIn` — things Basic and OIDC largely cannot service; conversely Basic *requires* `password` on `confirmSignUp` where the map makes it optional (D-AB-9). And `AuthState.user` is typed as the narrow `AuthUser`, so `auth-oidc.ts` down-projects to `{ userId, username }` and Cognito's groups/attributes are dropped from the state-machine payload. **Unification is therefore as much a shared-state-machine problem as a config problem.**
2. **`bb-auth-oidc`'s public types aren't actually public.** `packages/bb-auth-oidc/API.md` carries `ae-forgotten-export` warnings for `ProviderConfig`, `AuthOIDCOptions`, and every provider type, and `packages/blocks/src/index.ts` re-exports only `AuthOIDCErrorName | MappedClaims | OIDCUser | RelayOrigin` (vs ~30 Cognito types). The best provider abstraction in the repo is the least reachable one.

Also note two live drift hazards: `index.mock.ts` and `index.aws.ts` in `bb-auth-oidc` contain *duplicated* engine-dispatch switches with an in-code comment recording that "when they drifted, the mock built `OidcClientEngine` for cognito-federated and ran OIDC discovery against an empty issuer, crashing `npm run dev`"; and `packages/bb-auth-basic/DESIGN.md`'s cross-BB comparison table is stale — it claims AuthOIDC uses a "Self-signed JWT cookie" (it uses an opaque `sessionId`) and that AuthCognito supports "Social sign-in ✅ (federation)", directly contradicted by `bb-auth-cognito/DESIGN.md`.

### 8.1 Mapping table

| better-auth concept | Nearest AWS Blocks / Cognito equivalent | Gap / decision needed |
| --- | --- | --- |
| `betterAuth({...})` — one call, one options object | one unified auth BB constructor: `new Auth(scope, 'auth', { … })` | **This is the refactor.** Today a user picks between `bb-auth-basic`, `bb-auth-cognito`, `bb-auth-oidc` — and the choice is *irreversible in practice*, because each has a different session format, user type, and error vocabulary. Target: one class, one options object, mechanisms as keys. |
| `emailAndPassword: { enabled: true }` | `AuthCognito`'s pool with `signInWith` + `passwordPolicy`; or `AuthBasic` entirely (`KVStore` ×2 + `AppSetting` + HS256 JWT) | Name the key for the *mechanism*, not the implementation (`emailAndPassword`, not `basic`). **Resolve `requireSpecialChars` (Basic) vs `requireSymbols` (Cognito)** — one `PasswordPolicy`, and note `packages/blocks` currently re-exports Basic's version under the shared name. Decide whether `AuthBasic`'s no-Cognito path survives as a mode or is dropped (it is the only one with "no sign-in rate limiting — brute-force attacks succeed locally" in its DESIGN). |
| `socialProviders: { google: {...} }` | `AWS::Cognito::UserPoolIdentityProvider` of type Google/Facebook/Apple/Amazon + app-client `supportedIdentityProviders` | **`AuthCognito` supports none of this today** (`disableOAuth: true`, hosted UI never used, DESIGN.md: "not supported"). Federation exists only in `AuthOIDC` via `cognitoFederated()`, which stands up its **own second user pool**. The single largest structural decision in the refactor is which pool owns federated users. Cognito's native social set is small (Google, Facebook, Apple, Amazon) — everything else is `oidc`/`saml`. |
| Generic OIDC (`genericOAuth({ config: [...] })`) | `bb-auth-oidc`'s `customOidc()` / `customOauth2()` (own relay, `OidcClientEngine`) **and** `cognitoFederated()` (through Cognito, `CognitoFederationEngine`) | We have *both* answers already implemented behind one `kind` discriminant. The gap is not capability, it's coherence: going through Cognito unifies the session model but drags in the custom-resource pain (§6); going beside it keeps deploys clean but means two session mechanisms. Pick one as the default and keep the other as a documented mode — do not leave it as an undocumented `kind`. |
| `discoveryUrl` auto-discovery at startup | `OidcClientEngine` discovery; Cognito OIDC IdP takes an issuer + explicit endpoints | Discovery must not happen at synth (non-deterministic, needs network) and should be cached lazily in the handler. The mock must need no network — `stubIdp` already provides the offline path (it mounts its own `.well-known/openid-configuration`, `jwks.json`, `authorize`, `token`, `userinfo`, `revoke` routes). **Keep `stubIdp`; it is the reason we can do what Amplify can't.** |
| Provider helper functions returning `GenericOAuthConfig` | **already implemented**: `google()`, `github()`, `stubIdp()`, `customOidc()`, `customOauth2()`, `cognitoFederated()` in `packages/bb-auth-oidc/src/providers.ts` | Not a gap in capability — a gap in *reachability*. `ProviderConfig` / `AuthOIDCOptions` and every provider type are `ae-forgotten-export` in `API.md`, and `packages/blocks` re-exports only 4 OIDC types vs ~30 Cognito ones. **Export them properly as part of the unification.** |
| `OAuthProvider` common interface | `ProviderConfigBase` + the `ProviderKind` discriminated union | Already the right shape for federated providers; it does **not** yet cover Cognito-native password/OTP auth, so the unified BB needs one contract that spans "credential mechanism" and "federated provider". Add an `accountSubject`-equivalent so identity resolution is separate from profile mapping (today `mapClaims` / `attributeMapping` do both). |
| `accountSubject` (identity) vs `mapProfileToUser` (profile) | Cognito `sub` (immutable) vs `attributeMapping` (Cognito-enforced) vs `mapClaims` (our code, `oauth2-custom` only) | Copy the *separation* and the `id?: never` type guard on the mapped-profile type. Today `OIDCUser` carries both `sub` and a derived `userId = ${iss}:${sub}`, and `CognitoUser` carries both `userId` and a duplicate `userSub` — **pick one identity field and one derivation rule** for the unified user. |
| `user` table | Cognito user pool user (`sub`, `email`, `email_verified`, standard + custom attributes); `userAttributes` in `AuthCognito` options | We don't own it. **Today four user types disagree** — `AuthUser { userId, username }`, `AuthBasicUser` (+`createdAt`), `CognitoUser<O>` (+`attributes`, `groups`, `userSub`), and `OIDCUser` (+`provider`, `sub`, `iss`, `email`, `name`, `claims`, and *not* declared `extends AuthUser`). Converge on one base + typed per-mechanism extensions, and stop down-projecting to `{ userId, username }` in `AuthState.user` (which currently discards Cognito groups/attributes). Extra app fields → a separate data BB keyed by `sub`. |
| `session` table + `listSessions`/`revokeSession`/`revokeOtherSessions` | three different session mechanisms today (stateless JWT / `KVStore` + HMAC pointer / `KVStore` + versioned envelope + CAS refresh); `admin.revokeUserSessions()` ≈ `AdminUserGlobalSignOut` | **Real gap, and partly a lie we already ship.** Cognito has no per-device session list, so `listSessions`/`revokeOtherSessions` are not expressible. `AuthBasic` "cannot revoke individual sessions" at all (stateless JWT). And `bb-auth-cognito/DESIGN.md` already records that `revokeUserSessions` "does not flip `checkAuth` immediately on AWS" (the access token lives out its TTL). Either omit these APIs or document the reduced semantics precisely — better-auth's cookie-cache revocation-lag callout is the model for how to say it. |
| `account` table + `listAccounts`/`linkSocial`/`unlinkAccount` | Cognito linked federated identities (`AdminLinkProviderForUser` / `AdminDisableProviderForUser`) | Partial and unimplemented. Linking exists as an admin API; listing linked providers is awkward (identities live on the user record). Any exposed method must be gated (rule 9), and admin-shaped operations belong behind the existing opt-in `auth.admin` getter + `AdminActionGate<O, A>` pattern rather than on the default RPC surface. |
| `verification` table (generic single-use tokens) | Cognito confirmation codes, `ForgotPassword`/`ConfirmForgotPassword`, custom-auth challenges | Cognito owns these. Don't build a token table; map to Cognito's code flows and surface them through the existing `confirmSignIn`-style state machine. |
| `session.expiresIn` / `updateAge` / `freshAge` | `sessionDuration` (Basic, default 86400) vs `sessionTtlSeconds` (Cognito, cookie `Max-Age` defaulting to **400 days**) vs the OIDC envelope `exp`; app-client token validity | Three names and three wildly different defaults for the same concept — converge on one option name and one default, and state it. `expiresIn`/`updateAge` map to token validity. **`freshAge` has no equivalent** and is cheap to add in our session layer — adopt it for sensitive operations. |
| `session.cookieCache` strategies (`compact`/`jwt`/`jwe`) | three hand-rolled cookie layers: `auth-common/src/cookies.ts` (security attrs only), `bb-auth-cognito/src/cookies.ts` (name builder + HMAC + anchored read + a second encrypted auto-sign-in cookie), `bb-auth-oidc/src/session-cookie.ts` (`v1.` envelope) | We have a cookie three times over, and **`AuthBasic` reads it with an unanchored, unescaped regex** — the exact prefix-collision/metachar bug Cognito's `cookies.ts` explicitly fixed. Unification should promote *one* cookie module into `auth-common` (it already owns the `SameSite`/`Secure`/`Partitioned` decision after a documented drift incident) and adopt better-auth's habit of naming the trade-off (size / readable / encrypted) and the revocation-lag caveat in prose. Also fix `bb-auth-oidc`'s mock hard-coding `isLocalhost: true` at construction instead of sniffing per request like the other two. |
| Stateless mode (no DB) | `AuthBasic`'s HS256-JWT-as-cookie is exactly this; Cognito and OIDC are stateful (`KVStore`-backed) | We already ship both tiers, which is good — it means better-auth's revocation-lag and cookie-version-bump guidance applies directly to the `AuthBasic` mode. One concrete mock-fidelity bug to carry forward: `AuthBasic`'s mock `AppSetting` **regenerates the JWT secret on restart, invalidating all tokens**, so local sessions silently die across a dev-server restart. |
| Documented mock↔AWS fidelity table | `bb-auth-cognito/DESIGN.md` already has one | **Already doing this better than any of the four references** (none of which has a mock at all). Carry the table into the unified BB and keep it honest — current entries include: no wire-format exercise, **MFA accepts any 6-digit code**, no email/SMS, no Lambda triggers, no advanced security, no rate limiting, password-policy regex may drift, and **mock passwords stored in plaintext**. Also carry forward `bb-auth-oidc`'s known mock hole: `cognitoFederated()` is unusable under `npm run dev` and throws an actionable error at sign-in. |
| `useSession()` reactive client hook | typed import of the backend + client middleware; no reactive store today | Gap worth scoping: a small reactive session store on the client would remove a lot of boilerplate. Must respect the Transferable/client-middleware pattern rather than inventing a parallel one. |
| `auth.api.getSession({ headers })` | `auth.getSession(context)` / `auth.requireAuth(context)` inside a handler | Ours is better (context is already in scope). Keep it terse; don't grow a headers argument. |
| `auth.api.*` exempt from rate limiting | **no equivalent** — every method is public RPC | Do not port any API whose safety rests on "server-only" (e.g. `setPassword`). Gate everything explicitly. |
| Plugins (`plugins: [twoFactor()]`) | `ApiNamespace` + `createApi()` + client middleware; no plugin bus | Prefer typed option callbacks over a new seam (§4.4). **We already made the right call here:** MFA is `mfa` + `mfaTypes` keys and passkeys are `enablePasskeys` + `webAuthnRelyingParty` keys in `AuthCognitoOptions` — options, not plugins. Keep going that way. |
| `hooks.before/after` on auth paths | `AuthOIDC`'s `onSignIn` / `onSignOut` callbacks; Cognito Lambda triggers (`preSignUp`, `postConfirmation`, `preTokenGeneration`, `customMessage`) — **explicitly out of scope for `bb-auth-cognito` today** ("attach against `userPool` directly") | Two half-answers that should become one. `onSignIn`/`onSignOut` exist only on OIDC; triggers exist only as a raw-CDK instruction. Decide how triggers surface — Amplify-style `triggers: { preSignUp }` resource references are the proven shape, and note Amplify's cost (no inline handler, so a 3-line check needs its own directory). |
| `user.validateUserInfo` single policy gate | `preSignUp` / `preAuthentication` triggers; `onSignIn` on OIDC only | **Adopt the shape, implement via triggers.** One named gate that admits or rejects an identity, uniform across mechanisms, returning `{ error, errorDescription }`. This is better-auth's single highest-value extension point and we have no equivalent that spans mechanisms. |
| `signIn.email` returning `twoFactorRedirect` (a plugin changing an existing flow's response without changing its signature) | our `AuthState` state machine + `getAuthState`/`setAuthState` (`AuthActionPayloadMap`) | Same pattern, better executed on our side — except the shared contract is already Cognito's vocabulary: `AuthActionPayloadMap` carries 8 `confirmSignIn` challenge variants, passkey actions, and `autoSignIn` that Basic and OIDC cannot service, while Basic *requires* `password` on `confirmSignUp` where the map makes it optional (D-AB-9). And `AuthOIDC.setAuthState` handles exactly one action, returning `"Unknown action: …"` for everything else. **Unification is as much a shared-state-machine problem as a config problem** — the action vocabulary must become a function of the configured mechanisms (which `AuthCognito<const O>` already proves is possible). |
| Typed action/override helpers | `bb-auth-cognito/src/ui.ts` (`cognitoOverrides()`, `CognitoActionName`, `CognitoNextStepName`) exposed as a `./ui` subpath | Only Cognito has them, so Basic's and OIDC's action vocabularies are untyped at the renderer. And `ui.ts` carries a "Keep in lockstep with `state-machine.ts`" comment — a manual-sync coupling that should be derived, not maintained. |
| `sendVerificationEmail` / `sendResetPassword` / `sendMagicLink` callbacks | Cognito-sent messages, SES integration, `customMessage` trigger — or our own `bb-email-client` | Decide who sends mail. If Cognito sends it, we get less control but zero wiring; if we send it, we need the callback shape *and* `bb-email-client` composition. The callback signature `({ user, url, token }) => void` is worth copying either way. |
| `$ERROR_CODES` + a doc page per error | `isBlocksError(e, SomeErrors.Foo)`, error constants per BB (Basic 5, Cognito 29, OIDC 8) | Structure matches; **the vocabulary does not.** The same condition has different names across the three: 401 is `SessionExpiredException` (Basic) vs `NotAuthenticatedException` (Cognito, OIDC — which also has `TokenExpiredException`); "user exists" is `UserAlreadyExistsException` vs `UsernameExistsException`; "bad code" is `InvalidCodeException` vs `CodeMismatchException`/`ExpiredCodeException`. Unification **must** pick one set — this is a breaking change for anyone matching on names (rule 6) and needs maintainer sign-off. Then ship the doc page per error, with recommended UI handling, for the errors users actually build screens for. |
| `rateLimit` + per-path `customRules` (`/sign-in/email` at 3 per 10 s) | none at BB level; Cognito's own throttling; API Gateway throttling | Real gap, and `bb-auth-basic/DESIGN.md` states it plainly: "no sign-in rate limiting (**brute-force attacks succeed locally**)". Decide whether the unified BB declares stricter limits for sign-in paths and where they'd be enforced, or documents reliance on Cognito + API Gateway. Sign-in brute force is the one place a default matters. |
| `secret`/`secrets` + `process.env.X as string` (better-auth) · `secret('NAME')` (Amplify) | **`SecretLike = string \| (() => string \| Promise<string>)`** + `AppSettingLike` + `memoizedSecretResolver`, already in `bb-auth-oidc` | We already have the best version of this idea in the repo (a thunk resolved at use time, with failures deliberately not memoized). Gap: it's only in `bb-auth-oidc`, and `cognitoFederated()` needs the `AppSettingLike` variant so the CDK layer can read `.fullId` (D7). Standardize one secret-reference type across the unified BB and export it. |
| `advanced.cookiePrefix` / `crossSubDomainCookies` / `useSecureCookies` | `auth-common/src/cookies.ts` | Already have the primitive. Copy the *documentation* of the Safari ITP cross-domain failure mode; it's the kind of thing a user debugs for a day. |
| `auth` CLI (`generate`/`migrate`) | `cdk deploy`; `bb-data` migrations for SQL BBs | No analogue needed — CDK is our migration tool for pool config, and that's strictly better for the auth case. |
| `llms.txt` + per-page `.md` + docs MCP + agent skills | per-BB `README.md`/`DESIGN.md`, `node_modules/@aws-blocks/blocks/README.md` as the index | Cheap win, outside this refactor's scope: publish a machine-readable index of BB docs. |

---

## 9. Recommended adoptions (ranked)

Split into *adopt* (new to us) and *consolidate* (we already have it, unevenly).

### Adopt

1. **One `Auth` BB, one options object, mechanisms as sibling keys.** `emailAndPassword` next to `providers`, MFA and passkeys as peer keys (as `AuthCognito` already does). No package choice, no second construct. The evidence that this is right in an AWS context specifically is Amplify's `defineAuth` + `loginWith`.
2. **Providers as a keyed record, not an array** — `providers: { okta: {...}, google: {...} }` rather than `providers: [...]`. better-auth and Amplify both use keys; Auth.js's array is the one thing it does worse, because "is this mechanism enabled?" becomes a runtime question. Reuse the **same id string** on server config and client call (`providers.okta` → `signIn({ provider: 'okta' })`) — Amplify's `externalProviders.google` → `signInWithRedirect({ provider: 'Google' })` mismatch is a pure own-goal.
3. **Close the type-flow gap explicitly, as a named goal.** None of the four references narrows the client from the server config (better-auth comes closest; Amplify's `nextStep.signInStep` union is identical regardless of config, even though Amplify's own `defineData` does flow types). We already have the machinery (`ProviderName<P>`, `AuthCognito<const O>`, `ReadAttrOf<O>`, `GroupOf<O>`). Make it a tested invariant: **enabling a mechanism must change the client's types**, and reachable `AuthState` actions must be a function of the config.
4. **Separate identity from profile, at the type level.** An `accountSubject`-equivalent that reads the verified claim, and a mapped-profile type that *cannot* carry an id (better-auth's `id?: never`). Auth.js's `profile()` conflates them and we currently do too (`mapClaims` / `attributeMapping`).
5. **A single `validateUserInfo`-shaped policy gate** that fires for every mechanism and returns `{ error, errorDescription }`, implemented over Cognito triggers. This is better-auth's highest-value extension point and we have nothing that spans mechanisms (only OIDC's `onSignIn`).
6. **Session freshness (`freshAge`)** as a named concept gating sensitive operations.
7. **Write down the gating truth table.** Clerk's `auth.protect()` documents exactly what happens for authenticated-but-unauthorized (404, deliberately, to avoid leaking existence) vs unauthenticated (redirect / 401). Our `requireAuth(context)` / `requireRole(ctx, role)` should have the same table in its JSDoc, and `requireRole` should exist on all mechanisms, not just Cognito.
8. **Named-long-form dangerous options** (`allowDifferentEmails`, `disableImplicitLinking`, `trustedProviders`, …), each with a warning in its JSDoc — better-auth's shape with Auth.js's honesty (`allowDangerousEmailAccountLinking` names the risk; that bluntness belongs in the doc comment even if not in the identifier).
9. **A documented auth error catalogue** with recommended UI handling per error — after resolving the three-way name collision (§8.1). Note this is a **breaking change** for anyone matching on error names (rule 6) and needs maintainer sign-off before implementation.
10. **A rate-limit answer for sign-in.** Today `bb-auth-basic/DESIGN.md` says brute force succeeds locally. Either declare stricter limits for sign-in paths or document reliance on Cognito + API Gateway — but decide.

### Consolidate (already in the repo, unevenly)

11. **Promote `bb-auth-oidc`'s provider union and factories to the unified BB's public surface**, and *export the types* (they are `ae-forgotten-export` today, and `packages/blocks` re-exports 4 OIDC types vs ~30 Cognito ones). Extend `ProviderConfigBase` to span credential mechanisms as well as federated providers, so there is one contract and one runtime path — the thing Auth.js does better than better-auth.
12. **Standardize one secret-reference type.** `SecretLike` (a thunk) plus the `AppSettingLike` variant is already better than Amplify's `secret('NAME')`; it just needs to be the single answer across the BB, and it keeps us clear of `process.env.X as string` (rule 8).
13. **One session mechanism, one cookie module, one `User` type, one option name per concept.** Concretely: fold the three cookie implementations into `auth-common` (fixing `AuthBasic`'s unanchored regex and `bb-auth-oidc`'s hard-coded `isLocalhost: true`); pick one identity field and derivation rule (today: username vs `sub` vs `${iss}:${sub}`, with `CognitoUser` duplicating `sub` as `userSub`); collapse `sessionDuration` / `sessionTtlSeconds`; collapse `requireSpecialChars` / `requireSymbols`; collapse the 2-arg and 3-arg `CodeDeliveryFn`.
14. **Make the state-machine vocabulary a function of the configured mechanisms.** `AuthActionPayloadMap` is currently Cognito's vocabulary imposed on all three, `AuthState.user` down-projects to `{ userId, username }` and discards Cognito groups/attributes, and `AuthOIDC.setAuthState` answers one action out of the union. Derive the action set (and the typed UI overrides, which only Cognito has) from the config rather than hand-syncing `ui.ts` to `state-machine.ts`.
15. **Generalize the synth-time immutability guards** already in `bb-auth-cognito` into a documented "immutable after first deploy" list with actionable errors. This is the highest-severity concrete failure in the prior art — Amplify will *silently drop and recreate your user pool* for an unsupported edit ("Unsupported modifications, such as deleting a required field, result in Amplify dropping and recreating the user pool") — and it is the clearest place for us to be visibly better. Include the `featurePlan` side-effect landmine and `bb-auth-oidc`'s `PhysicalResourceId`-forces-replacement rule.
16. **Lean into the mock layer as the headline differentiator, and keep the fidelity table honest.** None of the four references can iterate on auth config offline: Amplify deploys real Cognito (Gen1's `amplify mock` was removed and never covered the user pool), Clerk always hits its API, Auth.js has no infra to mock. We already have `stubIdp` mounting a full offline IdP and a documented mock↔AWS fidelity table. Make "sign-up → confirm → sign-in → federated sign-in, fully offline" a tested first-run experience — and close the two known holes (`cognitoFederated()` unusable under `npm run dev`; `AuthBasic`'s mock secret regenerating on restart).
17. **Kill the duplicated engine-dispatch switch** between `bb-auth-oidc`'s `index.mock.ts` and `index.aws.ts` — its own in-code comment records that when the two drifted, the mock ran OIDC discovery against an empty issuer and crashed `npm run dev`. Also correct the stale cross-BB comparison table in `bb-auth-basic/DESIGN.md` (it claims AuthOIDC uses a self-signed JWT cookie and that AuthCognito supports federation; both are wrong).

---

## Appendix: pages reviewed

`/docs/introduction`, `/docs/installation`, `/docs/basic-usage`, `/docs/comparison`,
`/docs/concepts/{api,client,cookies,database,hooks,oauth,plugins,rate-limit,session-management,typescript,users-accounts}`,
`/docs/authentication/{email-password,google,cognito,other-social-providers}`,
`/docs/plugins/{generic-oauth,2fa,magic-link,organization,sso}`,
`/docs/adapters/drizzle`, `/docs/reference/options`, `/docs/guides/your-first-plugin`,
plus `better-auth/better-auth@main`: `packages/core/src/oauth2/oauth-provider.ts`, `packages/core/src/oauth2/index.ts`, `packages/core/src/social-providers/index.ts`, `packages/core/src/social-providers/cognito.ts`, `packages/core/src/db/get-tables.ts`.

Adjacent (docs repos + library source, since these sites are client-rendered SPAs with no `.md` variant):
`aws-amplify/docs` → `build-a-backend/auth/{set-up-auth,concepts,concepts/external-identity-providers,concepts/multi-factor-authentication,concepts/user-attributes,modify-resources-with-cdk,use-existing-cognito-resources,connect-your-frontend/*}`, `deploy-and-host/{fullstack-branching/secrets-and-vars,sandbox-environments/setup}`, plus `packages/auth-construct/src/types.ts` and `packages/backend-auth/src/factory.ts` for `AuthProps`/`AmplifyAuthProps`;
`nextauthjs/next-auth` → `docs/pages/getting-started/{installation,authentication/credentials,providers/google}`, `guides/configuring-oauth-providers`, `concepts/{database-models,session-strategies}`, plus `packages/core/src/providers/oauth.ts`;
`clerk/clerk-docs` → `guides/configure/auth-strategies/social-connections/{overview,custom-provider}`, `cli`, and the `auth()` / `auth.protect()` / `useUser()` / `currentUser()` references.

Internal survey (read-only, at HEAD): `packages/bb-auth-basic/{src,README.md,DESIGN.md}`, `packages/bb-auth-cognito/{src,README.md,DESIGN.md,API.md}`, `packages/bb-auth-oidc/{src,README.md,DESIGN.md,API.md}`, `packages/auth-common/src/{index,ui,cookies}.ts`, `packages/blocks/src/{index,ui}.ts`, `docs/DECISIONS.md` (D-004, D-005), `docs/tech-design/BB-auth-cognito-admin*.md`.
