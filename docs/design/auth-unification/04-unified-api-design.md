# Unified Auth Building Block — API Design Proposal

> **Status:** proposal for maintainer review. Planning only — no source files were modified.
> **Scope:** replace `bb-auth-basic` + `bb-auth-cognito` + `bb-auth-oidc` + `auth-common` with **one**
> Cognito-backed Building Block in which Cognito-native auth and generic OIDC/SAML federation are
> configured through the same options object.
> **Motivation:** users cannot tell which of the three blocks to reach for.
> **Inspiration:** better-auth's single-config DX (`emailAndPassword` / `socialProviders` / plugins).

**Checkable against:** `docs/design/API-DESIGN.md` G1–G18 (self-review in §8) and `AGENTS.md` Core rules 1–13.

---

## 0. What the research established (load-bearing facts this design is built on)

These were verified in the tree at HEAD (`bbd2c13d`). They constrain the design more than any preference does.

| # | Fact | Consequence for this design |
|---|---|---|
| F1 | **The state-machine wire contract is already unified.** `AuthState` / `AuthAction` / `AuthField` / `AuthUser` / `AuthStateApi` live in `auth-common` and all three BBs emit the same shapes. `native/codegen-fixtures/18-hybrid-arm/spec.json` freezes them for Kotlin/Swift/Dart codegen. | **Do not change the wire contract.** Unify the *construction* side only. This is the single biggest risk reducer available. |
| F2 | `AuthActionPayloadMap` has 14 action keys; **13 are Cognito-only** and its own JSDoc admits a BB that doesn't support an action fails at *runtime* despite typechecking. | Unifying makes the map honest and converts that runtime hole into a compile error. |
| F3 | **No sibling BB depends on auth.** `bb-realtime` and `bb-agent` have zero auth imports. The only cross-BB coupling is `bb-data`'s codegen template, duck-typed as `{ requireAuth(ctx): Promise<{ userId: string }> }`. | Blast radius is apps/templates/tests, not the BB graph. `requireAuth` must keep returning `{ userId, … }`. |
| F4 | **The repo already solved compile-time capability gating** — `auth.admin` uses a **parameter-position rest-tuple gate** (`...gate: AdminActionGate<O,'groups'>`) *specifically because* a shape-narrowing conditional over the class's own `O` made `AuthCognito<O>` invariant and regressed 14 call sites (`docs/tech-design/BB-auth-cognito-admin-implementation-plan.md`, `src/admin.types-test.ts` case 8). | Reuse this exact technique for mode gating. Do **not** invent a new one. |
| F5 | Provider secrets for Cognito federation must be **`AppSetting` references**, not strings or closures: `CreateIdentityProvider` runs at *deploy* time via a custom resource that reads the SSM parameter name. | `clientSecret` is typed as an `AppSettingRef`, never `string`. |
| F6 | `registerRoute` bans `/` and `/aws-blocks/api*`, allows `/aws-blocks/auth/*`, permits **one** wildcard which must be the final segment. `core/src/hosting.ts` already adds exactly one CloudFront behavior for `${BLOCKS_AUTH_PREFIX}/*`. `bb-auth-oidc` uses **~15 explicit RawRoutes and zero wildcards**. | Mount everything under `/aws-blocks/auth/...` with explicit per-provider paths. AGENTS.md rule 12 is satisfied by construction. |
| F7 | Only the **RawRoute** AWS dispatch path splits `Set-Cookie` into `multiValueHeaders`. The **RPC** path does `Object.fromEntries(responseHeaders.entries())`, which collapses multiple `Set-Cookie` values. | Latent bug today (Cognito sets a session cookie with `headers.set` and an autoSignIn bridge cookie with `headers.append`). See §7.6. |
| F8 | `preventUserExistenceErrors: true` **is already in main** (PR #293). Two residual enumeration vectors remain: the mock's `resendSignUpCode`/`confirmResetPassword`/challenge paths throw `UserNotFound` (mock is now *leakier than AWS* — a parity inversion), and `signUp` throws `UsernameExistsException`/409 on **both** runtimes (`PreventUserExistenceErrors` does not mask sign-up). | §6.3 closes both. |
| F9 | `fix/auth-reactivity-185` (PR #208, **open**) adds `submitAuthAction()` as the single "submit + notify" entry point. `onAuthChange` is callback-only — there is no exported `getSnapshot`, and the cache/`updateState` are private, so React cannot use `useSyncExternalStore`. | §5 adopts `submitAuthAction` as the documented default and proposes a real store. |
| F10 | **Two non-Cognito auth blocks are in flight**: `origin/feat/bb-auth-jwt` (`AuthBearerJwt`) and `origin/supabase-auth-poc` (`bb-auth-supabase`). No branch is attempting unification; `refactor/auth-blocks` is empty (fresh off main). | Directly affects the naming decision — see OPEN DECISION 1. |
| F11 | Dropping the non-Cognito OIDC engine loses: bare OAuth 2.0 (GitHub, any `customOauth2` + `mapClaims`), third-party JWKS/RS256 verification, nonce replay protection on the relay path, the `stubIdp()` offline-dev story, and zero-Cognito deploys. | §2.6 and OPEN DECISION 4. The stub IdP must be *kept* and repointed, or `npm run dev` has no federated sign-in at all. |
| F12 | **`docs/reference/ARCHITECTURE-LAYERS.md` and `docs/reference/building-block-structure.md` are stale.** Both describe `client-hook.ts` / `index.ts` / `infra.ts` / `mock.ts` with a `materialize()` function and `CfnOutput`-based env injection. The real model is `index.mock/aws/cdk/browser.ts` + `registerConfig`. | Treated as non-normative. `AGENTS.md` + `packages/bb-kv-store/` are the authority. Fixing these two docs should be a task in this workstream (they will actively mislead anyone implementing this proposal). |

### Hard Cognito service constraints (evidence: `03-cognito-capabilities.md`, AWS-doc-cited)

| # | Fact | Consequence |
|---|---|---|
| F13 | **Federated sign-in cannot go through the SDK at all.** AWS, verbatim: *"You can't sign in federated users with API operations like `InitiateAuth`… federated users can only sign in with the Login endpoint or the Authorize endpoint."* A user-pool **domain is mandatory** for any federation. | **There is no transport at which one uniform method surface covers both.** Native = RPC; federated = browser redirect. This is the crux of §3 and §4, not a detail. Design two honestly-different shapes behind one config object. |
| F14 | **Generic OIDC/SAML MAUs are priced separately: 50 free, then $0.015/MAU flat across all tiers** — vs **10,000 free** for direct *and* social sign-in. | A **200× smaller free tier**, and the asymmetry is *within* federation: named social providers are cheap, generic OIDC is not. §2.2 makes that visible in the config shape rather than smoothing it over. |
| F15 | **Federated users get no MFA, no device tracking, no adaptive auth.** AWS: *"In the case of federated users, Amazon Cognito delegates all authentication processes to the IdP and doesn't offer them additional authentication factors."* | `mfa`, `passkeys`, and `users.deviceTracking` are **native-only** options. `bb-auth-oidc/README.md:366-369` claims the opposite ("MFA on social sign-in") — **a doc bug to fix regardless of this refactor**, since it is the primary stated reason a user would choose the expensive path. |
| F16 | **Cognito as an OIDC relying party: client secret mandatory, `client_secret_post` only (no `client_secret_basic`), no PKCE toward the IdP, ports 80/443 only, HTTPS only, `kid` required.** Cognito **never forwards the IdP's tokens** to your app. | **PKCE-only and public-client IdPs cannot be federated through Cognito at all.** `clientSecret` is required, not optional. The supported subset must be explicit in the types and JSDoc. |
| F17 | **Four user-pool properties are immutable at the service level while CloudFormation reports "No interruption":** sign-in/alias attributes, `UsernameConfiguration.CaseSensitive`, required attributes, and existing custom attributes. CDK synths fine, then `UpdateUserPool` rejects → **stack rollback, not replacement.** | `users.signInWith` and `users.attributes` are effectively **create-only**. Say so in the JSDoc and refuse the change at synth (§2.5). |
| F18 | **Cognito defaults new pools to Essentials ($0.015/MAU).** Omitting `UserPoolTier` silently opts the customer into a paid tier. Essentials is *required* for passkeys, `USER_AUTH`, email MFA, refresh-token rotation, password history, and managed login. | The BB's tier default **is a pricing decision** and must be documented as one. |
| F19 | **Mutually exclusive combinations:** passwordless OTP ⊥ required MFA; `CUSTOM_AUTH` ⊥ federation in one app client; refresh-token rotation ⊥ `REFRESH_TOKEN_AUTH`; `mfa.types: ['EMAIL']` needs Essentials **and** your own SES. | Some config combinations are not expressible. Reject them — at compile time where the encoding allows, at synth otherwise (§2.5). |
| F20 | **Attribute mapping loses data silently:** unmapped claims are dropped; multi-valued claims are flattened to `[a,b,c]` and URL-encoded (group/role claims are the usual casualty); 2,048-byte ceiling per attribute; mapped emails are unverified by default; stale claims are never removed; the app client must have write access to every mapped attribute or the value is dropped **with no error**. | `attributeMapping` cannot be sold as "claims pass through." Cap the promise in the JSDoc, and never present `user.attributes` as a general profile store (50 attrs, 20-char names, non-removable, 25 RPS `UserUpdate`). |
| F21 | **Hosted-UI sign-out is not sign-out.** The managed-login cookie survives `GlobalSignOut`, so a federated session silently re-authenticates on the next sign-in attempt. | A `signOut()` that only calls the API **is a security bug on the federated path.** §4.5 encodes the fix in the API contract. |
| F22 | **Local-dev fidelity: Cognito-native capabilities mock at grade B or better; everything hosted-UI/federation rates F** — the repo's own mock literally throws `cognitoUnavailableLocally()`. | Directly contradicts the framework's "everything runs locally with no AWS account" promise. §7.2 must say concretely what `index.mock.ts` does for a federated sign-in. Also the strongest single argument for OPEN DECISION 0. |

### Inventory findings (evidence: `01-inventory.md`, `file:line`-cited)

| # | Fact | Consequence |
|---|---|---|
| F23 | **`BlocksAuth` (3 methods) is the only contract all three BBs implement — and two independent unmerged efforts (`feat/bb-auth-jwt` PR #297, `supabase-auth-poc`) each *re-derived the same shape* for stateless providers.** Three independent derivations. | **Extend `BlocksAuth`, do not replace it.** This is the strongest evidence in the whole workstream that the existing shape is right. |
| F24 | **`requireRole` is the missing interface member.** Cognito has it; the Supabase PoC added it; JWT approximates it; Basic and OIDC have nothing. | Promote `requireRole` into `BlocksAuth` (§3.1). |
| F25 | **The "common" state machine is ~60% Cognito-private:** 6 of 15 `AuthActionPayloadMap` keys plus the entire 8-arm `confirmSignIn` union serve only Cognito. Handled-action counts: **Cognito 14, Basic 6, OIDC 1** (`signOut` only, `auth-oidc.ts:429`). OIDC also adds a *third* RPC method, `getClient()`, returning a Transferable — which breaks the `AuthStateApi` shape outright. | **The existing code already failed to unify these.** Do not force federation into a state machine built for Cognito; use the one place they genuinely converge (§4.2) and drop `getClient()` (§5.2). |
| F26 | **Cognito's mock (2332 lines) and AWS (2465 lines) layers are two *independent* classes reimplementing 42 methods with no shared base.** `bb-auth-oidc` proves a base-class + pluggable-engine alternative works, with **169-line** entry files. | Adopt base-class + engine (§7.0). Biggest structural win available. **Caveat:** Cognito's `index.aws.ts` has only **6** default-run tests (one a pure function); the rest are `BLOCKS_INTEGRATION=1`-gated and skipped by `npm test`. **Closing that test gap is a prerequisite, not a follow-up.** |
| F27 | **`bb-auth-basic` and `bb-auth-cognito` share the cookie name `auth_${fullId}` with incompatible payloads** (HS256 JWT vs. HMAC'd session id). | A migration hazard: a stale `AuthBasic` cookie must degrade to "signed out", never crash. §7.7. |

---

## 0.5 The central structural resolution: RPC vs. redirect

F13 forecloses the tempting design. There is **no transport at which one uniform method surface covers
both** native and federated sign-in: native auth is `InitiateAuth`/`RespondToAuthChallenge` over
JSON-RPC, federated auth is a browser navigation to a hosted `/authorize` endpoint. Faking uniformity
would mean either a method that sometimes returns data and sometimes returns "now go navigate the
browser somewhere", or an RPC that cannot work. F25 is the empirical confirmation: the existing
"common" state machine is ~60% Cognito-private, OIDC implements exactly **one** of its 14 actions, and
OIDC had to bolt on a third RPC method that breaks the shared `AuthStateApi` shape.

**So this design unifies four things and deliberately splits one.**

| Layer | Unified? | How |
|---|---|---|
| **Configuration** | **Unified** | One options object, one constructor, one block. This is the DX win the refactor is actually for — the user's complaint is "which block do I pick", and that is answered at construction, not at call time. |
| **Client UI** | **Unified** | `auth-common`'s form model (**D-005**): an `AuthAction` carries either internal `fields` (native → RPC) or a `url` + `method` (federated → browser form submit). `<Authenticator>` renders "Sign in with Okta" as a sibling of the password form with **zero client branching**. `03-cognito-capabilities.md` §3.4 independently reaches the same conclusion: *"the BB can unify the data shape but not the control flow… This is the right abstraction and the merged BB should preserve it. It is the only place the two mechanisms genuinely converge."* |
| **Session** | **Unified** | One signed HttpOnly cookie → one server-side session record in one `KVStore`, regardless of how the user signed in. `bb-auth-oidc` already proves this is engine-agnostic: its `SessionManager` is injected into both engines. |
| **Identity & authorization** | **Unified** | `AuthenticatedUser<O>`, `requireAuth`, `requireRole`, `getCurrentUser`, `checkAuth` behave identically for native and federated users. `signInProvider` is the one field that tells them apart. |
| **Server method surface** | **Split, honestly** | Native credential methods and federated redirect methods are different sets, and the **compile-time gate (§3.5) makes the split visible in the editor** rather than at runtime in production. Calling `signIn()` on an OIDC-only instance is a type error, not a 400. |

The one method that must span both is `signOut()`, because of F21 — and it spans it using the *same*
D-005 mechanism (§4.5).

This is why §3.5 and §4 are the load-bearing sections of this proposal, and why the recommendation in
**OPEN DECISION 0** (which engine actually performs generic-OIDC federation) matters more than any
naming or ergonomics choice in the rest of the document.

---

## 1. The naming decision

### The constraint
`docs/DECISIONS.md` **D-004** mandates auth-first naming: `Auth` leads every class, type, and package
(`AuthBasic`, `AuthCognito`, `AuthOIDC`; `bb-auth-*`). Its stated rationale is IDE autocomplete
grouping *across the family* — "customers start typing `Auth` and autocomplete shows all auth
Building Blocks together, making it easy to compare options."

That rationale is precisely the thing we are trying to delete. The comparison step *is* the confusion.

### Options

| Option | Class · package | For | Against |
|---|---|---|---|
| **A** | `Auth` · `@aws-blocks/bb-auth` | One obvious answer; nothing left to compare. Shortest name for the most-used block. Still auth-first (trivially). Reads well: `new Auth(scope, 'auth')`. | Claims the generic name while `AuthBearerJwt` / `AuthSupabase` are in flight (F10) → a family of `Auth` + `AuthBearerJwt` + `AuthSupabase` reads oddly. Largest import churn. |
| **B** | `AuthCognito` · `@aws-blocks/bb-auth-cognito` | Zero churn for the biggest existing surface (5 test apps, the `auth-cognito` template, `official-bb-names.generated.ts`, the `getSdkIdentifiers` overload, the vendorize map). Honest about the backend. Symmetric with future siblings. | Keeps a *choice-shaped* name. A newcomer still asks "do I want Cognito?" — which is the original confusion, minus two options. Undersells that this is now **the** auth block. |
| **C** | `Auth` · `@aws-blocks/bb-auth-cognito` | — | Class/package mismatch; worst of both. Rejected. |

### Recommendation: **Option A — `Auth`, package `@aws-blocks/bb-auth`**

The motivation for this whole refactor is *choice paralysis*. Option B leaves the choice visible in
the name; Option A removes it. The cost is import churn, which a preview-stage service can absorb
(the admin plan already records "Breaking changes are acceptable — the service is in preview").

The F10 objection is answerable: `AuthBearerJwt` and `AuthSupabase` are **not alternatives to `Auth`
for the same job.** `AuthBearerJwt` verifies tokens minted elsewhere (no sign-in flow at all);
`AuthSupabase` is a different backend for teams already on Supabase. Documenting `Auth` as the
default and the others as specialized adapters is a coherent story — and the same story npm
ecosystems tell (`better-auth` vs. its plugins). Concretely, `packages/blocks/README.md`'s decision
tree collapses from three peer bullets to:

```
  - Need sign-in for your app?                     → `Auth`  (bb-auth)
  - Verifying tokens issued by someone else?       → `AuthBearerJwt`
  - Already on Supabase?                           → `AuthSupabase`
```

**Naming knock-ons (all required, none optional):**
- `bbName = 'Auth'`, and `'Auth'` must land in `packages/core/src/common/official-bb-names.generated.ts`
  (generated from the umbrella vendorize map). **If it doesn't, the block is counted as "custom" and
  silently omitted from user-agent strings and telemetry.**
- Types: `AuthOptions`, `AuthUser`, `AuthErrors`, `AuthSession`, `AuthProviders`. `AuthUser` **already
  exists** in `auth-common` as the minimal `{ userId, username }` — this design keeps that name for
  the minimal wire type and introduces `AuthenticatedUser<O>` for the richer server-side user (see §3.1).
  That avoids breaking the frozen `AuthState.user` wire shape.
- `auth-common` **does not die** — it becomes the home of the wire contract (F1) shared with
  `AuthBearerJwt` / `AuthSupabase`, plus `/ui` and `/cookies`. Collapsing it into `bb-auth` would
  force those two siblings to depend on the Cognito block. See OPEN DECISION 2.

---

## 2. The constructor / config object

### 2.1 The five required cases, as a user writes them

```ts
import { Auth, AppSetting } from '@aws-blocks/blocks';

// (a) email + password only — the one-liner. This is the default.
const auth = new Auth(scope, 'auth');

// (b) email + password + one generic OIDC provider
const oktaSecret = new AppSetting(scope, 'okta-secret', { secret: true });
const auth = new Auth(scope, 'auth', {
	oidcProviders: {
		okta: { issuer: 'https://dev-12345.okta.com', clientId: '0oa…', clientSecret: oktaSecret },
	},
});

// (c) OIDC-only — no native users. `emailPassword: false` also removes the
//     password methods from the type (§3.3) and the password forms from the UI.
const auth = new Auth(scope, 'auth', {
	emailPassword: false,
	oidcProviders: {
		okta: { issuer: 'https://dev-12345.okta.com', clientId: '0oa…', clientSecret: oktaSecret },
	},
});

// (d) a named social provider
const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });
const auth = new Auth(scope, 'auth', {
	socialProviders: { google: { clientId: '1234…apps.googleusercontent.com', clientSecret: googleSecret } },
});

// (e) everything at once — declarative, better-auth style
const auth = new Auth(scope, 'auth', {
	emailPassword: { passwordPolicy: { minLength: 12 }, selfSignUp: true },
	socialProviders: {
		google: { clientId: '…', clientSecret: googleSecret },
		apple: { clientId: '…', teamId: 'ABCDE12345', keyId: 'XYZ…', privateKey: applePrivateKey },
	},
	oidcProviders: {
		okta: { issuer: 'https://dev-12345.okta.com', clientId: '…', clientSecret: oktaSecret },
	},
	samlProviders: {
		partner: { metadataUrl: 'https://partner.example.com/saml/metadata' },
	},
	mfa: { mode: 'optional', types: ['TOTP'] },
	passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
	users: { signInWith: ['email'], groups: ['admins', 'readers'], attributes: [{ name: 'department' }] },
	session: { ttlSeconds: 60 * 60 * 24 * 30, crossDomain: false },
	admin: { actions: ['groups'] },
});
export const authApi = auth.createApi();
```

### 2.2 Why three provider keys, keyed records, and what that buys

**Keyed records, not an array.** The repo's current `AuthOIDC` takes `providers: readonly ProviderConfig[]`
built by factories (`google()`, `customOidc({ name: 'okta', … })`). That array is the one thing
Auth.js gets wrong and better-auth gets right, and this design fixes it: **the record key *is* the
provider id**, so the same string appears in the server config, in `getSignInUrl(context, 'okta')`,
and in the `signIn:okta` client action. Amplify's `externalProviders.google` → `signInWithRedirect({provider: 'Google'})`
mismatch is a self-inflicted DX wound; a keyed record makes it structurally impossible. Dropping the
factories also drops the redundant `name:` field and the `kind:` discriminant — the key carries the
former, the config group carries the latter.

**Three groups, not one.** A single `providers` record keyed by id is terser and is what I reached for
first. It cannot be made type-safe: with `{ [id: string]: SocialConfig | OidcConfig | SamlConfig }`, an
unknown key carrying a *social* shape (`{ clientId, clientSecret }`, no `issuer`) typechecks and is
meaningless — TypeScript has no way to say "arbitrary keys must carry a discriminant, known keys need
not." Closing the hole inside one record requires a mandatory `type: 'google'` on every entry, which is
the redundancy the keyed record was supposed to buy us out of. Three closed/open records are **fully
sound, need no discriminant, and are what better-auth does** (`socialProviders` closed + a separate
generic-OAuth config). Cost: a duplicate-id check across the three records (§2.5).

**And the split is load-bearing for cost, not just types.** Per **F14**, direct and *social* sign-in
share a **10,000**-MAU free tier; generic OIDC/SAML gets **50**, then $0.015/MAU flat. That is a 200×
cliff that falls exactly along the `socialProviders` / `oidcProviders` boundary. Putting Google and
Okta in one undifferentiated record would hide a 200× pricing difference behind two adjacent lines of
config. Keeping them in separate, separately-documented groups makes the expensive choice *visible at
the call site* — the same instinct as **G18**, applied to dollars instead of latency.

### 2.2a What this promotes from the existing blocks vs. what it replaces

| Existing type / idea | Disposition |
|---|---|
| `BlocksAuth` (`auth-common`) | **Promoted**, and extended with `requireRole` (F23, F24) |
| `AuthState` / `AuthAction` / `AuthField` / `AuthUser` / `AuthStateApi` / `AuthActionPayloadMap` | **Promoted verbatim** — frozen wire contract (F1) |
| `AuthCognito<const O>` + `GroupOf<O>` / `AttrOf<O>` / `ReadAttrOf<O>` / `MfaTypeOf<O>` | **Promoted verbatim.** These already close the server→client type-flow gap that better-auth, Auth.js, Clerk *and* Amplify all leave open (Amplify's `nextStep.signInStep` union is identical regardless of config). This is the framework's differentiator. |
| `AdminOptions` / `AdminSurface` / `AdminGetterOf` / `AdminActionGate` | **Promoted verbatim** — already compiler-verified with a variance guard |
| `SignInNextStep` (15 arms) / `SignInResult` / `ConfirmSignInResponse` | **Promoted verbatim** — frozen by native codegen |
| `AppSettingLike` (`{ fullId; get() }`) | **Promoted**, renamed `AppSettingRef`. It is already the thunk-carrying shape `SecretLike` wanted, *and* it exposes `fullId` so the CDK layer can grant/read the SSM parameter — which a bare thunk cannot (F5). |
| `auth-common/cookies` (`resolveCookieSecurity`, `buildCookieSecurityAttrs`, `isLoopbackRequest`) | **Promoted** (D-007) |
| `bb-auth-cognito/src/cookies.ts` anchored, `escapeRegex`'d cookie reader | **Promoted as the single cookie module.** `AuthBasic`'s reader uses an **unanchored, unescaped** regex — `my_auth_foo=` can satisfy a lookup for `auth_foo`. That bug must not be carried forward. |
| `stubIdp()` + `stub-idp.ts` (real RS256 keypair, real discovery, real JWKS, real PKCE) | **Promoted** — the single most valuable thing in `bb-auth-oidc` (F22, §7.2) |
| `relayOrigin()` / signed `state` envelope / `CallbackResult` union | **Promoted** |
| `providers: ProviderConfig[]` + `google()`/`github()`/`customOidc()`/`customOauth2()`/`cognitoFederated()` factories, `ProviderKind`, `ProviderConfigBase`, `name:` field | **Replaced** by the keyed records above. The tiering idea (named → helper → generic) survives; the array and the discriminant do not. |
| `AuthOIDC.getClient()` + `OIDCClient` Transferable | **Removed** (§5.2, F25) |
| `AuthBasic` `buildApi()`, bare-bcrypt-hash legacy `UserRecord`, `password`-on-`confirmSignUp` (D-AB-9) | **Removed** — zero in-repo callers / obviated by Cognito |
| `AuthBasicErrors`, `AuthOIDCEngineError`, `AuthOIDCConfigError` | **Replaced** by one `AuthErrors` (§6) |

**Explicitly rejected** (each incompatible with AWS Blocks' constraints): owning tables or schema
(better-auth's `additionalFields` — Cognito owns the directory, and F20 says custom attributes are not
a profile store); runtime provider registration (G7 — the constructor is the only side effect);
storing provider tokens in cookies (and Cognito never forwards them anyway, F16); pluggable password
hashing (Cognito owns it); and **anything whose safety rests on "this only runs server-side"** — every
method here is reachable as a public, unauthenticated RPC endpoint.

### 2.3 The interfaces

```ts
/**
 * Options for the `Auth` Building Block.
 *
 * Every capability is opt-in through its own named group, and the groups are
 * independent: enabling federation does not disable email+password, and
 * `emailPassword: false` does not stop you from configuring passkeys.
 *
 * **The zero-config default is email + password.** `new Auth(scope, 'auth')`
 * gives you self-service sign-up, sign-in, email-code confirmation and
 * password reset, with no AWS account needed locally.
 *
 * @example Minimal
 * ```ts
 * const auth = new Auth(scope, 'auth');
 * export const authApi = auth.createApi();
 * ```
 *
 * @example Google + Okta, no native users
 * ```ts
 * const auth = new Auth(scope, 'auth', {
 *   emailPassword: false,
 *   socialProviders: { google: { clientId: '…', clientSecret: googleSecret } },
 *   oidcProviders: { okta: { issuer: 'https://…', clientId: '…', clientSecret: oktaSecret } },
 * });
 * ```
 */
export interface AuthOptions {
	/**
	 * Email/username + password sign-in, backed by the Cognito user pool.
	 *
	 * `true` (or omitted) enables it with defaults. `false` disables it: the pool
	 * is created with self-sign-up off, the password methods become **compile
	 * errors** (§3.3), and the sign-in UI offers only the configured federated
	 * providers.
	 *
	 * @default true
	 */
	emailPassword?: boolean | EmailPasswordOptions;

	/**
	 * Cognito-native social identity providers. Closed set — these are the four
	 * providers Cognito registers with first-class support, so their options are
	 * fully typed per provider.
	 *
	 * **Billing:** social sign-in shares the **10,000 free MAU** tier with direct
	 * (email+password) sign-in. Unlike {@link AuthOptions.oidcProviders}, adding a
	 * social provider does not move you onto a separate meter.
	 *
	 * For any other IdP that speaks OIDC, use {@link AuthOptions.oidcProviders}.
	 */
	socialProviders?: SocialProviders;

	/**
	 * Generic OIDC identity providers, keyed by the id you will use in
	 * `getSignInUrl()` and in the `signIn:<id>` UI action. Each entry needs at
	 * minimum an `issuer` (discovery is performed against
	 * `{issuer}/.well-known/openid-configuration`), a `clientId`, and a
	 * `clientSecret`.
	 *
	 * ⚠️ **Billing — read this before shipping.** Generic OIDC and SAML monthly
	 * active users are metered **separately** from direct and social sign-in:
	 * **50 free MAUs, then $0.015/MAU**, flat across every Cognito feature plan.
	 * Direct and social sign-in get 10,000 free MAUs. Adding one generic OIDC
	 * provider therefore starts billing at your 51st federated user — a 200×
	 * smaller free tier. If your IdP is Google, Apple, Facebook or Amazon, use
	 * {@link AuthOptions.socialProviders} instead and stay on the large tier.
	 *
	 * ⚠️ **Not every OIDC provider can be federated.** Cognito acts as a
	 * confidential relying party: a client secret is **mandatory**, only
	 * `client_secret_post` is supported (not `client_secret_basic`), and Cognito
	 * performs **no PKCE toward your IdP**. A PKCE-only or public-client IdP
	 * cannot be federated. See `DESIGN.md` for the full supported subset.
	 *
	 * Ids must not collide with {@link AuthOptions.socialProviders} or
	 * {@link AuthOptions.samlProviders} keys — the constructor throws at synth if
	 * they do.
	 */
	oidcProviders?: Record<string, OidcProviderOptions>;

	/**
	 * SAML 2.0 identity providers, keyed by provider id.
	 * ⚠️ Metered on the same separate 50-free-MAU tier as
	 * {@link AuthOptions.oidcProviders}.
	 */
	samlProviders?: Record<string, SamlProviderOptions>;

	/**
	 * Multi-factor authentication. `'off' | 'optional' | 'required'` is shorthand
	 * for `{ mode }`.
	 *
	 * ⚠️ **Native sign-in only.** Cognito delegates authentication entirely to the
	 * IdP for federated users and *"doesn't offer them additional authentication
	 * factors"* — so MFA never applies to a user who signed in through
	 * `socialProviders` / `oidcProviders` / `samlProviders`. Enforce MFA at your
	 * IdP for those users.
	 *
	 * @default 'off'
	 */
	mfa?: MfaMode | MfaOptions;

	/**
	 * WebAuthn passkeys. Requires `users.authFlow: 'USER_AUTH'` and
	 * `featurePlan` above `'lite'`; both are enforced at synth.
	 *
	 * ⚠️ Native sign-in only — see {@link AuthOptions.mfa}.
	 * @default false
	 */
	passkeys?: false | PasskeyOptions;

	/** User pool shape: what counts as a username, which attributes exist, which groups exist. */
	users?: UserPoolOptions;

	/**
	 * A single cross-mechanism policy gate, called for **every** sign-in and
	 * sign-up regardless of mechanism — native, social, OIDC or SAML. Throw to
	 * reject; the thrown `ApiError` reaches the client by `name`.
	 *
	 * This is the one hook worth having: it is the only place a
	 * "corporate-domains-only" or "must be on the allowlist" rule can live
	 * without being duplicated per provider.
	 *
	 * @remarks
	 * On the **sign-in** path this runs in-process, in your own Lambda, after the
	 * token exchange and before the session cookie is issued — so rejecting
	 * prevents the session. On the **self-service sign-up** path, blocking before
	 * the user record is created requires a Cognito PreSignUp trigger, which the
	 * CDK layer provisions **only when this option is present**. See OPEN
	 * DECISION 11 — this is the one genuinely new capability in this proposal.
	 *
	 * @example
	 * ```ts
	 * validateUser: async ({ email, provider }) => {
	 *   if (provider !== 'password' && !email?.endsWith('@example.com')) {
	 *     throw new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
	 *   }
	 * }
	 * ```
	 */
	validateUser?: (candidate: UserCandidate) => Promise<void>;

	/** Session cookie and server-side session record behaviour. */
	session?: SessionOptions;

	/** HTTP paths for the federated redirect flow. All must sit under `/aws-blocks/auth/`. */
	redirects?: RedirectOptions;

	/**
	 * Enables the privileged `auth.admin` handle and grants the matching
	 * `Admin*`/`List*` IAM on the pool. Omit for the client-only surface with no
	 * admin grant — the default.
	 *
	 * **Unchanged from `AuthCognito`.** This shape is already compiler-verified
	 * (`src/admin.types-test.ts`) and ships today; it is carried over verbatim.
	 */
	admin?: AdminOptions;

	/**
	 * Accept `Authorization: Bearer <access token>` in addition to the session
	 * cookie. Needed by native/CLI clients that cannot hold a cookie.
	 *
	 * Note: bearer tokens are validated from their claims and are **not** checked
	 * against the session store, so a bearer token outlives `signOut()` until it
	 * expires.
	 * @default false
	 */
	allowBearerAuth?: boolean;

	/** Wrap a pre-existing Cognito user pool instead of provisioning one. @see Auth.fromExisting */
	userPool?: ExternalUserPoolRef;

	/** Called after a successful sign-in, before the response is returned. Throwing rolls the sign-in back. */
	onSignIn?: (user: AuthenticatedUser, context: BlocksContext) => Promise<void>;
	/** Called before the session is destroyed. Errors are logged, never blocking. */
	onSignOut?: (user: AuthenticatedUser, context: BlocksContext) => Promise<void>;

	/** `'destroy' | 'retain'` for the pool and the session table. @default 'destroy' */
	removalPolicy?: 'destroy' | 'retain';
	/**
	 * Cognito feature plan. Explicitly pinned (never left to the service default)
	 * so a pool cannot drift on `UpdateUserPool`.
	 *
	 * ⚠️ **This option is a pricing decision.** Cognito defaults new pools to
	 * **Essentials**, which is a paid tier, so omitting the property silently opts
	 * you in. `'lite'` is the cheapest but cannot run passkeys, `USER_AUTH`
	 * (choice-based / passwordless) sign-in, email MFA, password history,
	 * refresh-token rotation, or managed login — the BB throws at synth if you
	 * combine `'lite'` with any of those.
	 *
	 * @default 'essentials'
	 */
	featurePlan?: 'lite' | 'essentials' | 'plus';
	/** Optional logger. When omitted, a default `Logger` at `error` level is created. */
	logger?: ChildLogger;
}

/** Mock-only superset. Deliberately **not** re-exported from `@aws-blocks/blocks`, so passing
 *  `codeDelivery` from application code is a type error. */
export interface AuthMockOptions extends AuthOptions {
	/** Invoked for every generated code in local dev. Lets `npm run dev` print codes to the console. */
	codeDelivery?: CodeDeliveryFn;
	/** Local-only stand-in for the hosted IdP, so federated sign-in works offline. @see stubIdp */
	stubProviders?: Record<string, StubProviderOptions>;
}
export type CodeDeliveryFn = (
	username: string,
	code: string,
	purpose: 'signUp' | 'resetPassword' | 'mfa' | 'attribute',
) => Promise<void>;
```

```ts
export interface EmailPasswordOptions {
	/** Allow users to register themselves. When `false`, users are created only via `auth.admin`. @default true */
	selfSignUp?: boolean;
	/** Password strength requirements enforced by the pool. */
	passwordPolicy?: PasswordPolicy;
	/**
	 * Sign the user in automatically after they confirm their sign-up code.
	 * @default true
	 */
	autoSignIn?: boolean;
}

export interface PasswordPolicy {
	/** @default 8 */ minLength?: number;
	/** @default true */ requireUppercase?: boolean;
	/** @default true */ requireLowercase?: boolean;
	/** @default true */ requireDigits?: boolean;
	/** @default true */ requireSymbols?: boolean;
}
```

```ts
/**
 * A reference to an `AppSetting` holding a secret.
 *
 * Provider secrets **must** be `AppSetting` references rather than strings:
 * Cognito registers an identity provider at *deploy* time (a custom resource
 * reads the SSM parameter), so the value has to be resolvable by ARN at synth
 * and by `GetParameter` at deploy — a literal string in your backend module
 * would be committed to source and baked into the template.
 */
export interface AppSettingRef {
	readonly fullId: string;
	get(): Promise<string>;
}

/** The four providers Cognito registers natively. */
export type SocialProviderId = 'google' | 'apple' | 'facebook' | 'amazon';

export interface SocialProviders {
	google?: OAuthCredentials & ProviderCommon;
	facebook?: OAuthCredentials & ProviderCommon;
	amazon?: OAuthCredentials & ProviderCommon;
	/** Apple uses a signed JWT client assertion instead of a shared secret. */
	apple?: AppleCredentials & ProviderCommon;
}

export interface OAuthCredentials {
	/** Public client identifier. Not a secret; a literal string is fine. */
	clientId: string;
	/** Client secret, as an `AppSetting`. @see AppSettingRef */
	clientSecret: AppSettingRef;
}

export interface AppleCredentials {
	/** Services ID. */ clientId: string;
	/** Apple Developer team id. */ teamId: string;
	/** Key id for `privateKey`. */ keyId: string;
	/** The `.p8` signing key, as an `AppSetting`. */ privateKey: AppSettingRef;
}

export interface ProviderCommon {
	/**
	 * Scopes requested from the IdP. Defaults to `['openid', 'email', 'profile']`
	 * for OIDC providers and to the provider's documented minimum for social ones.
	 */
	scopes?: readonly string[];
	/**
	 * Maps IdP claims onto **profile** attributes, e.g. `{ email: 'email', name: 'name' }`.
	 *
	 * Identity is deliberately **not** mappable: `userId`, `userSub` and `sub` are
	 * typed `never` here, so a mapping cannot change who the user *is* — only what
	 * is known *about* them. (`mapClaims`/`attributeMapping` conflate the two
	 * today; so does Auth.js's `profile()`. Identity comes from the provider's
	 * subject, full stop.)
	 *
	 * ⚠️ **Claims do not pass through — they are mapped, and mapping loses data.**
	 * Unmapped claims are silently dropped. Multi-valued claims (group/role claims
	 * especially) are flattened to a URL-encoded `[a,b,c]` string you must parse.
	 * There is a 2,048-byte ceiling per attribute. Mapped email addresses are
	 * **unverified** unless you also map `email_verified`. Stale values are never
	 * removed when the IdP stops sending them. Declarative only — Cognito performs
	 * the mapping, so a function is not accepted (§2.6).
	 */
	attributeMapping?: Readonly<ProfileAttributeMapping>;
	/** Human-readable label for the generated `signIn:<id>` UI action. @default the provider id, title-cased */
	label?: string;
}

/** Profile-only mapping target. Identity keys are closed off at the type level. */
export type ProfileAttributeMapping = Record<string, string> & {
	sub?: never;
	userSub?: never;
	userId?: never;
};

/** What {@link AuthOptions.validateUser} receives. Identity is read-only. */
export interface UserCandidate {
	/** `'password'` for native sign-in, otherwise the provider id. */
	readonly provider: string;
	/** The provider's immutable subject. Never writable. */
	readonly subject: string;
	readonly email: string | null;
	readonly username: string;
	/** `'signUp' | 'signIn'` — which path triggered the check. */
	readonly phase: 'signUp' | 'signIn';
	/** Claims as received, before Cognito's attribute mapping loses anything. */
	readonly claims: Readonly<Record<string, unknown>>;
}

export interface OidcProviderOptions extends OAuthCredentials, ProviderCommon {
	/** Issuer URL. Endpoints are discovered from `{issuer}/.well-known/openid-configuration`. */
	issuer: string;
	/** Override discovery for a non-conformant IdP. All four are required together if any is set. */
	endpoints?: {
		authorization: string;
		token: string;
		userInfo: string;
		jwks: string;
	};
	/** How the userinfo endpoint is fetched. @default 'GET' */
	attributesRequestMethod?: 'GET' | 'POST';
	/**
	 * Which engine performs this federation.
	 *
	 * - `'direct'` — the app talks to the IdP itself (OIDC discovery, PKCE, real
	 *   JWKS verification). **Free**, works fully offline in `npm run dev` against
	 *   the built-in stub IdP, supports public/PKCE-only clients, and gives you
	 *   the raw ID token. The federated user does **not** get a Cognito pool
	 *   record, so pool groups and `auth.admin` do not apply to them.
	 * - `'cognito'` — Cognito federates on your behalf. The user becomes a pool
	 *   record, so `requireRole()` groups, `auth.admin`, and account linking work
	 *   uniformly with native users. Costs $0.015/MAU after 50 (F14), requires a
	 *   client secret (F16), and **cannot be exercised locally at all** (F22).
	 *
	 * @default see OPEN DECISION 0 — this default is the single most consequential
	 * choice in the design and is not yet settled.
	 */
	federateVia?: 'direct' | 'cognito';
	/**
	 * Claim to read group membership from, so `requireRole()` works for users of
	 * this provider. Only meaningful with `federateVia: 'direct'`, where the user
	 * has no Cognito pool record and therefore no `cognito:groups` claim.
	 *
	 * @example groupsClaim: 'groups'   // Okta, Entra
	 */
	groupsClaim?: string;
}

export interface SamlProviderOptions extends ProviderCommon {
	/** IdP metadata document URL. Mutually exclusive with `metadataFile`. */
	metadataUrl?: string;
	/** Inline IdP metadata XML. Mutually exclusive with `metadataUrl`. */
	metadataFile?: string;
	/** Require signed SAML requests. @default false */
	signRequest?: boolean;
}
```

```ts
export type MfaMode = 'off' | 'optional' | 'required';
export interface MfaOptions {
	/** @default 'off' */ mode?: MfaMode;
	/**
	 * Permitted second factors. `'EMAIL'` requires an existing pool with a
	 * configured email sender — the CDK layer throws at synth otherwise and
	 * points at `Auth.fromExisting`.
	 * @default ['SMS', 'TOTP']
	 */
	types?: readonly ('SMS' | 'TOTP' | 'EMAIL')[];
}

export interface PasskeyOptions {
	/** Relying-party id: the apex domain, no scheme and no port. There is no safe default. */
	relyingPartyId: string;
	/** Exact allowed origins, e.g. `['https://example.com']`. */
	origins: readonly string[];
	/** @default 'preferred' */ userVerification?: 'required' | 'preferred' | 'discouraged';
}

export interface UserPoolOptions {
	/**
	 * What a user types as their username. @default ['username', 'email']
	 *
	 * ⚠️ **Create-only.** Cognito's sign-in/alias attributes are immutable after
	 * the pool exists. CloudFormation reports this property as `No interruption`
	 * and will happily call `UpdateUserPool`, which Cognito then **rejects** —
	 * producing a failed stack update and rollback, not a replacement. Changing
	 * this on a deployed pool means a new pool and a user migration, so the BB
	 * refuses the change at synth with that explanation.
	 */
	signInWith?: readonly ('username' | 'email' | 'phone')[];
	/**
	 * **Custom** attributes only — standard OIDC attributes are implicit.
	 *
	 * ⚠️ **Additive only.** Existing custom attributes and required attributes are
	 * immutable at the service level (same `No interruption`-then-rollback trap as
	 * `signInWith`). You can add attributes; you cannot rename, retype or remove
	 * one. Limits: 50 custom attributes, 20-char names, 2,048 bytes each,
	 * string-only in tokens, 25 RPS on `UserUpdate` (not raisable).
	 *
	 * ⚠️ **This is not a profile database.** AWS's own guidance is to keep profile
	 * data in your own store. Use `KVStore` or `DistributedTable` keyed on
	 * `user.userSub` for anything beyond a handful of stable identity attributes.
	 */
	attributes?: readonly UserAttribute[];
	/**
	 * Groups to create. `requireRole()`'s argument narrows to this literal union.
	 *
	 * @remarks Group membership is read from the cached `cognito:groups` ID-token
	 * claim, so a group change lands on the user's **next sign-in or token
	 * refresh**. Call `auth.admin.revokeUserSessions(username)` for immediate
	 * effect. Federated users only have groups when `federateVia: 'cognito'`.
	 */
	groups?: readonly (string | { name: string; description?: string; precedence?: number })[];
	/**
	 * @default 'USER_PASSWORD_AUTH'; `'USER_AUTH'` is required for passkeys and
	 * choice-based/passwordless sign-in, and itself requires `featurePlan` above
	 * `'lite'`.
	 *
	 * `CUSTOM_AUTH` is deliberately not offered: Cognito cannot combine custom-auth
	 * triggers with federation in one app client, and this block always keeps
	 * federation available.
	 */
	authFlow?: 'USER_PASSWORD_AUTH' | 'USER_AUTH';
	/** Remember devices to skip MFA on a known device. ⚠️ Native sign-in only (F15). */
	deviceTracking?: { challengeRequiredOnNewDevice?: boolean; deviceOnlyRememberedOnUserPrompt?: boolean };
}

export interface SessionOptions {
	/** Session record + cookie lifetime in seconds. @default 34_560_000 (400 days) */
	ttlSeconds?: number;
	/**
	 * Set `true` only when the frontend and API are on different registrable
	 * domains. Switches the cookie to `SameSite=None; Secure; Partitioned`.
	 * @default false
	 * @see docs/DECISIONS.md D-007
	 */
	crossDomain?: boolean;
	/**
	 * How recently the user must have authenticated for
	 * `requireAuth(context, { fresh: true })` to succeed, in seconds.
	 *
	 * Use for step-up on destructive actions ("delete account", "change email")
	 * without maintaining a second session. A long-lived session stays valid for
	 * ordinary reads while sensitive routes demand a recent sign-in.
	 *
	 * @default 900 (15 minutes)
	 */
	freshAgeSeconds?: number;
}

export interface RedirectOptions {
	/** @default '/aws-blocks/auth/callback' — must start with `/aws-blocks/auth/`. */
	callbackPath?: string;
	/** @default '/aws-blocks/auth/signout' */
	signOutPath?: string;
	/** Where the browser lands after a successful federated sign-in. @default '/' */
	postSignInPath?: string;
	/**
	 * Allowlist of non-HTTP(S) relay targets for native clients (e.g.
	 * `relayOrigin('myapp://auth')`). Empty means server-initiated and
	 * browser-PKCE flows only.
	 */
	allowedRelayOrigins?: readonly RelayOrigin[];
}
```

### 2.4 The class

```ts
// AuthBase extends Scope and implements BlocksAuth; each entry point subclasses it
// and injects its engines (§7.0). The public shape is identical across entry points.
export class Auth<const O extends AuthOptions = AuthOptions> extends AuthBase implements BlocksAuth {
	readonly options: O;
	constructor(scope: ScopeParent, id: string, options?: O);

	/** Reference an existing Cognito user pool. Returns a reference object for `options.userPool`, not an `Auth`. */
	static fromExisting(userPoolId: string, clientId?: string): ExternalUserPoolRef;
}
```

`const O` is carried over from `AuthCognito` (already shipped) so inline literals narrow without
`as const`: `groups: ['admins']` makes `requireRole`'s parameter `'admins'`, and
`oidcProviders: { okta: … }` makes `getSignInUrl`'s parameter `'okta'`.

### 2.5 Constructor-time validation (fail at synth, with the fix in the message)

All are plain `Error` — per `bb-auth-basic`'s **D-AB-10**, configuration mistakes are not catchable
conditions and must not get a named constant that code could branch on. One exception:
`ProviderMisconfigured` is named because it is also reachable at runtime on the mock path.

**Configuration coherence:**
- Duplicate provider id across `socialProviders` / `oidcProviders` / `samlProviders`.
- `emailPassword: false` **and** no federated provider → no way to sign in at all.
- An `oidcProviders` entry with neither `issuer` nor a complete `endpoints` block.
- A `samlProviders` entry with both or neither of `metadataUrl` / `metadataFile`.
- `redirects.*` not under `/aws-blocks/auth/`.
- `fullId.length > 128` (Cognito pool-name limit).
- **`mfa`, `passkeys` or `users.deviceTracking` set together with `emailPassword: false`** — all three
  are native-only (F15), so the combination is always a mistake. This one is cheap to make a
  **compile** error via the same rest-tuple technique as §3.5, and should be.

**Combinations Cognito cannot express** (F19 — each must fail at synth with the reason, not at deploy):

| Rejected combination | Why |
|---|---|
| `passkeys` without `users.authFlow: 'USER_AUTH'` | passkeys exist only on the choice-based flow |
| `passkeys` / `authFlow: 'USER_AUTH'` / `mfa.types: ['EMAIL']` with `featurePlan: 'lite'` | all require Essentials or higher |
| passwordless OTP **and** `mfa: 'required'` | mutually exclusive |
| `mfa.types` including `'EMAIL'` on a BB-created pool | needs your own SES sender; message points at `Auth.fromExisting` |
| refresh-token rotation with `REFRESH_TOKEN_AUTH` | AWS: rotation *"isn't compatible with the authentication flow `REFRESH_TOKEN_AUTH`"* — the BB picks one refresh code path at synth |

**Create-only properties (F17) — refuse the *change*, not the value.** `users.signInWith` and the
identity-shaping parts of `users.attributes` are immutable at the service level while CloudFormation
reports `No interruption`, so a change synths cleanly and then rolls the stack back on
`UpdateUserPool`. The CDK layer must compare against the deployed pool (CDK context / a custom-resource
read) and **throw at synth** with: what changed, why Cognito will reject it, and that the remedy is a
new pool plus a user migration. Failing at synth instead of mid-deploy is the whole value here.

### 2.6 Capability deltas vs. today (the honest list)

**Everything in this table applies only to providers that federate *through Cognito*** — i.e. all of
`socialProviders` and `samlProviders`, plus any `oidcProviders` entry with `federateVia: 'cognito'`.
It is the price list for OPEN DECISION 0 option (a). Providers on `federateVia: 'direct'` keep all of
it.

| Dropped | Why | Mitigation |
|---|---|---|
| `github()` and any `customOauth2()` provider | Cognito cannot federate bare OAuth 2.0 without an ID token | None available in-block. Document the `RawRoute` escape hatch, or keep a non-Cognito engine (OPEN DECISION 4). |
| `mapClaims(raw)` / `getUserInfo` functions | Cognito performs claim mapping server-side | Declarative `attributeMapping` only |
| Third-party JWKS/RS256 verification of IdP tokens | Only Cognito's own tokens are verified | Accepted: Cognito verified the IdP token upstream |
| Nonce replay protection on the relay path | `CognitoFederationEngine` deliberately omits `nonce` | Flag as a hardening follow-up; not a regression |
| Zero-Cognito deployment (no pool, no MAU cost) | A pool is now mandatory | Accepted consequence of the premise |
| Runtime rotation of an IdP secret without `cdk deploy` | The secret is baked into the pool at deploy time (F5) | Document that rotating a provider secret needs a deploy |
| Public / PKCE-only IdP clients, `client_secret_basic` | Cognito is a confidential RP with `client_secret_post` only and no PKCE toward the IdP (F16) | **Such an IdP cannot be federated via Cognito at all.** `federateVia: 'direct'` is the only path. |
| MFA, device tracking, adaptive auth for federated users | Cognito delegates authentication wholly to the IdP (F15) | Enforce at the IdP. **And fix `bb-auth-oidc/README.md:366-369`, which currently claims the opposite.** |
| Full claim fidelity | Only pre-declared mapped attributes survive; multi-valued claims mangled; 2,048-byte cap; unmapped claims dropped silently (F20) | Cap the promise in JSDoc; recommend a `DistributedTable` keyed on `userSub` for real profile data |
| Local development of federated sign-in | The hosted `/authorize` endpoint does not exist locally; the current mock throws `cognitoUnavailableLocally()` (F22) | §7.2 — either a mock hosted-UI shim, or `federateVia: 'direct'` |
| Programmatically distinguishing IdP misconfiguration from IdP downtime | Cognito collapses every IdP failure into `error=invalid_request&error_description=…` on your callback | Surface the raw `error_description`; document that it is coarse |
| Styling the sign-in page | The hosted UI is mandatory for federation (F13); proper branding needs Essentials **and** a `ManagedLoginBranding` resource | Native forms stay fully app-owned; only the federated hop is hosted |

**Kept, and must not regress:** `stubIdp` (repointed — see §7.2; without it `npm run dev` has no
federated sign-in at all), `allowBearerAuth`, the relay flow with its HMAC-signed `state` envelope,
and the `/aws-blocks/auth/*` path family.

---

## 3. The runtime method surface

Legend — **layer**: M = `index.mock.ts`, A = `index.aws.ts`, C = `index.cdk.ts` (`synthGuard` stub),
B = `index.browser.ts` (throws). **Mode**: `all` = every configuration; `pw` = requires
email+password; `fed` = requires ≥1 federated provider; `gated` = behind an options gate.

### 3.1 Session & identity — available in all modes

This set **extends `BlocksAuth`** rather than replacing it (F23). `BlocksAuth`'s three members have now
been independently re-derived by three separate efforts (`bb-auth-jwt` PR #297 and `supabase-auth-poc`
both arrived at the same shape for stateless providers), which is about as strong a signal as an
interface gets. The one change proposed to the interface itself is **promoting `requireRole` into it**
(F24): Cognito has it, the Supabase PoC added it, `bb-auth-jwt` approximates it, and Basic and OIDC have
nothing — it plainly belongs in the contract.

> **Subtle but load-bearing:** `BlocksAuth.requireRole(context, role: string)` and this block's
> `requireRole(context, role: GroupOf<O>)` are compatible *only* because `BlocksAuth` declares its
> members with **method shorthand**, which TypeScript treats bivariantly. Rewriting `BlocksAuth` to use
> property-with-function-type syntax would turn parameters contravariant and break every narrowing
> implementation. Add a comment to `auth-common` saying so.

```ts
/**
 * Require an authenticated user, or throw 401.
 *
 * | Session state | `requireAuth(ctx)` | `requireAuth(ctx, { fresh: true })` |
 * |---|---|---|
 * | no cookie / unknown session | throws 401 `NotAuthenticated` | throws 401 `NotAuthenticated` |
 * | valid, authenticated recently | returns the user | returns the user |
 * | valid, older than `session.freshAgeSeconds` | returns the user | throws 401 `ReauthenticationRequired` |
 * | valid, but user disabled or deleted upstream | throws 401, clears the cookie | same |
 *
 * @throws {ApiError} 401 `AuthErrors.NotAuthenticated`
 * @throws {ApiError} 401 `AuthErrors.ReauthenticationRequired` — only with `{ fresh: true }`
 */
requireAuth(context: BlocksContext, options?: { fresh?: boolean }): Promise<AuthenticatedUser<O>>;
/**
 * @throws {ApiError} 401 `NotAuthenticated`; 403 `NotAuthorized` when not in the group
 * @remarks Groups come from the cached ID-token claim, so membership changes apply on the next
 * sign-in or refresh. Federated users have groups only under `federateVia: 'cognito'`.
 */
requireRole(context: BlocksContext, role: GroupOf<O>, options?: { fresh?: boolean }): Promise<AuthenticatedUser<O>>;
checkAuth(context: BlocksContext): Promise<boolean>;
/** Returns `null` when unauthenticated (G3). Clears a stale cookie as a side effect. */
getCurrentUser(context: BlocksContext): Promise<AuthenticatedUser<O> | null>;
/** Never throws; `{ tokens: undefined }` when unauthenticated. */
getAuthSession(context: BlocksContext, options?: { forceRefresh?: boolean }): Promise<AuthSession>;
getUserAttributes(context: BlocksContext): Promise<Partial<Record<ReadAttrOf<O>, string>>>;
updateUserAttributes(context: BlocksContext, attributes: Partial<Record<AttrOf<O>, string>>):
	Promise<Partial<Record<AttrOf<O>, UpdateAttributeOutcome>>>;
confirmUserAttribute(context: BlocksContext, name: AttrOf<O>, code: string): Promise<void>;
sendUserAttributeVerificationCode(context: BlocksContext, name: AttrOf<O>): Promise<void>;
signOut(context: BlocksContext, options?: { global?: boolean }): Promise<void>;
deleteUser(context: BlocksContext): Promise<void>;
createApi(): AuthStateApi;
```
Layers: M A C B for all. `createApi()` on C returns the
`Object.assign(() => ({}), { [Symbol.for('blocks:ApiNamespace')]: 'auth' })` stub that exists today
(so shared IFC code runs under `--conditions=cdk` without emitting a broken second namespace) — a
test locks that contract.

```ts
/** The minimal wire user. Frozen by `AuthState.user` and the native codegen fixtures (F1). */
export interface AuthUser { userId: string; username: string }

/** What the server methods return. Extends the wire user with pool-derived detail. */
export interface AuthenticatedUser<O extends AuthOptions = AuthOptions> extends AuthUser {
	/** Cognito-assigned UUID (`sub`). Stable for the user's lifetime — key your data on this. */
	userSub: string;
	/** Resolved from the `cognito:groups` claim. Narrowed by `users.groups`. */
	groups: GroupOf<O>[];
	/** Standard OIDC attributes plus `custom:*`. */
	attributes: Partial<Record<ReadAttrOf<O>, string>>;
	/** `'password'` for native sign-in, otherwise the federated provider id. */
	signInProvider: 'password' | ProviderIdOf<O>;
}

export interface AuthSession {
	tokens?: { idToken: JWT; accessToken: JWT };
	userSub?: string;
}
```

> **`userId` semantics change** for migrating users. Today: `AuthBasic` `userId === username`;
> `AuthCognito` `userId === username` with the UUID in `userSub`; `AuthOIDC` `` userId = `${iss}:${sub}` ``.
> Unified: `userId === username`, UUID in `userSub`. Anything keyed on an `AuthOIDC` `userId`
> (e.g. `test-apps/comprehensive`'s `oidcProfiles` KVStore, `bb-data`'s generated CRUD) needs a
> migration. See OPEN DECISION 6.

### 3.2 Federated sign-in — mode `fed`

```ts
/**
 * Build the IdP authorize URL and set the pending-auth cookie on `context.response`.
 * Most apps never call this — the `signIn:<id>` action in `getAuthState()` carries
 * the URL and the browser submits a plain form to it (D-005).
 * @throws {ApiError} 400 `ProviderNotConfigured`
 */
getSignInUrl(
	context: BlocksContext,
	provider: ProviderIdOf<O>,
	options?: { redirectPath?: string; state?: string },
	...gate: FederationGate<O>
): Promise<string>;

/** Exchange a browser-PKCE authorization code. Drives `POST /aws-blocks/auth/exchange`. */
handleExchange(input: ExchangeInput, context: BlocksContext, ...gate: FederationGate<O>): Promise<ExchangeResult>;
/** Authorize parameters for a native/relay client. Drives `GET|POST /aws-blocks/auth/authorize-params/<id>`. */
getAuthorizeParams(context: BlocksContext, provider: ProviderIdOf<O>, request?: AuthorizeParamsRequest,
	...gate: FederationGate<O>): Promise<AuthorizeParams>;
/** Bearer-token refresh. Returns `null` when `allowBearerAuth` is false. */
refreshBearerTokens(input: { refreshToken: string; provider: ProviderIdOf<O> }, context: BlocksContext,
	...gate: FederationGate<O>): Promise<BearerRefreshResult | null>;

export type ProviderIdOf<O extends AuthOptions> =
	| (keyof NonNullable<O['socialProviders']> & string)
	| (keyof NonNullable<O['oidcProviders']> & string)
	| (keyof NonNullable<O['samlProviders']> & string);
```
Layers: M A C B. `handleCallback` is **not public** — it is reached only through the callback
RawRoute (§4.3), which removes a footgun that exists today.

### 3.3 Email + password — mode `pw`

```ts
signUp(username: string, password: string, options?: SignUpOptions<O>, context?: BlocksContext,
	...gate: PasswordGate<O>): Promise<SignUpResult>;
confirmSignUp(username: string, code: string, context?: BlocksContext, ...gate: PasswordGate<O>): Promise<ConfirmSignUpResult>;
resendSignUpCode(username: string, ...gate: PasswordGate<O>): Promise<void>;
signIn(username: string, password: string, context: BlocksContext, options?: SignInOptions,
	...gate: PasswordGate<O>): Promise<SignInResult<O>>;
confirmSignIn(session: string, response: ConfirmSignInResponse<O>, context: BlocksContext,
	options?: ConfirmSignInOptions<O>, ...gate: PasswordGate<O>): Promise<SignInResult<O>>;
autoSignIn(context: BlocksContext, ...gate: PasswordGate<O>): Promise<SignInResult<O>>;
/** Never reveals whether the user exists (§6.3). */
resetPassword(username: string, ...gate: PasswordGate<O>): Promise<ResetPasswordResult>;
confirmResetPassword(username: string, code: string, newPassword: string, ...gate: PasswordGate<O>): Promise<void>;
updatePassword(context: BlocksContext, oldPassword: string, newPassword: string, ...gate: PasswordGate<O>): Promise<void>;
```
`SignInResult<O>` and `SignInNextStep` (the 15-arm challenge union) are carried over **verbatim** from
`bb-auth-cognito/src/types.ts`. The `status: 'signedIn' | 'continueSignIn'` string discriminator is
load-bearing: native Swift/Kotlin/Dart codegen cannot build a union off a boolean.

**MFA** — mode `pw`, additionally gated on `mfa !== 'off'`:
`setUpTotp`, `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`.
**Devices** — mode `pw`: `scanDevices(): AsyncIterable<DeviceRecord>`, `rememberDevice`, `forgetDevice`.
**Passkeys** — gated on `passkeys`: `startPasskeyRegistration`, `completePasskeyRegistration`,
`listPasskeys`, `deletePasskey`.

### 3.4 Admin — mode `gated`

Carried over **unchanged** from the shipped `AuthCognito` design: `get admin(): AdminGetterOf<O>`,
with `GroupAdmin` (4 methods) and `LifecycleAdmin` (9 methods), `AdminUser<O>`, `AdminCreateInit<O>`,
`AdminUserFilter`, `SetPasswordOptions`, and the `AdminActionGate<O, A>` rest-tuple. It is already
compiler-verified with a variance guard and there is no reason to touch it.

### 3.5 **What happens when you call a native-only method on an OIDC-only instance**

**Recommendation: a compile error, via the parameter-position rest-tuple gate the repo already uses
for `auth.admin` (F4) — with a runtime `ApiError` as a backstop for untyped JavaScript callers.**

```ts
/** `true` unless the user explicitly wrote `emailPassword: false`. */
export type EmailPasswordEnabled<O extends AuthOptions> = O extends { emailPassword: false } ? false : true;

/**
 * `[]` when email+password is enabled, so the method is callable normally.
 * When disabled, a single `never` parameter whose *name is the error message*.
 */
export type PasswordGate<O extends AuthOptions> =
	EmailPasswordEnabled<O> extends true ? [] : [ERROR_emailPassword_is_disabled_on_this_Auth_instance: never];

export type HasFederatedProvider<O extends AuthOptions> =
	ProviderIdOf<O> extends never ? false : true;
export type FederationGate<O extends AuthOptions> =
	HasFederatedProvider<O> extends true ? [] : [ERROR_no_federated_provider_is_configured: never];
```

```ts
const auth = new Auth(scope, 'auth', { emailPassword: false, oidcProviders: { okta: { … } } });

await auth.requireAuth(context);                       // ✅ mode-agnostic
await auth.getSignInUrl(context, 'okta');              // ✅ narrowed to 'okta'
// @ts-expect-error ERROR_emailPassword_is_disabled_on_this_Auth_instance
await auth.signIn('alice', 'pw', context);
// @ts-expect-error 'github' is not a configured provider
await auth.getSignInUrl(context, 'github');
```

**Why this encoding and not the obvious ones.**

- *Hiding the methods behind a conditional property type* (`get password(): PasswordEnabled<O> extends true ? … : Disabled`)
  is the intuitive answer and it is **recorded as a failure in this repo**: a conditional over the
  class's own `O` used in a property position made `AuthCognito<O>` invariant in `O`, breaking the
  contract that `AuthCognito<Narrow>` is assignable to `AuthCognito<AuthCognitoOptions>` — which
  regressed 14 existing call sites. The rest-tuple form lives in *parameter* position and keeps the
  class covariant; `admin.types-test.ts` case 8 is a standing variance guard.
- *A namespace handle* (`auth.password.signIn(…)`) would also gate cleanly, but it buries the single
  most-called method in the framework one level deeper and forces a rewrite of every template, test
  app, and native e2e for a case that ~90% of apps never hit.
- *Runtime-throw only* fails the "prefer the type system" bar and gives no editor feedback.

**Runtime backstop.** Every gated method still checks first and throws
`ApiError(409, { name: AuthErrors.EmailPasswordNotEnabled })` / `AuthErrors.NoFederatedProvider`, so
a plain-JS caller gets an actionable error rather than a confusing Cognito failure.

**Required before committing to this:** land an `Appendix-A`-style `types-test.ts` proving the eight
cases (gate off/on for both gates, provider-id narrowing, `emailPassword: true` vs omitted vs
`{…}`, and a `takesWide(auth: Auth)` variance regression guard) **before** any runtime code, exactly
as the admin plan sequenced T2 ahead of T3.

---

## 4. `createApi()`, the RPC surface, and the redirect flow

### 4.1 The RPC surface does not change

```ts
export interface AuthStateApi {
	getAuthState(): Promise<AuthState>;
	setAuthState(input: AuthActionInput): Promise<AuthState>;
}
createApi(): AuthStateApi;   // = new ApiNamespace(this, 'auth', (context) => ({ getAuthState, setAuthState }))
```

Two methods, same names, same shapes (F1). The wire namespace still comes from the customer's export
name (`export const authApi = auth.createApi()`), not from the `'auth'` string. `AuthState`,
`AuthAction`, `AuthField`, `AuthUser` are untouched, so
`native/codegen-fixtures/*/spec.json`, the Kotlin/Swift/Dart clients, `auth-common/ui`'s renderer,
and the documented `data-testid` contract all keep working.

`AuthActionPayloadMap` keeps all 14 keys and finally becomes **honest**: every key is now supported by
the one block that emits the map, closing the documented "typechecks but fails at runtime" hole (F2).
`AuthBasic`'s `confirmSignUp` requiring a `password` (D-AB-9) disappears — Cognito does not need it,
which is why the shared map already types it optional.

### 4.2 Federated sign-in is an `AuthAction` with a `url`, not an RPC method

Per **D-005** there is no redirect action type: OAuth *is* a form submission. So the `signedOut`
state simply gains one action per configured provider, and **no new RPC method is needed**:

```ts
{
  state: 'signedOut',
  actions: [
    { name: 'signIn', label: 'Sign in', fields: [ {name:'username',…}, {name:'password',…} ] },
    { name: 'signUp', label: 'Create account', fields: [ … ] },
    { name: 'resetPassword', label: 'Forgot password?', fields: [ {name:'username',…} ] },
    // ↓ one per federated provider — `url` present ⇒ the client submits a plain GET form
    { name: 'signIn:google', label: 'Sign in with Google',
      fields: [], url: '/aws-blocks/auth/signin/google', method: 'GET' },
    { name: 'signIn:okta',   label: 'Sign in with Okta',
      fields: [], url: '/aws-blocks/auth/signin/okta',   method: 'GET' },
  ],
}
```

With `emailPassword: false` the first three actions are simply absent — so the OIDC-only case needs
no client change at all, and the type-level gate (§3.5) and the UI agree by construction. The
`signIn:<id>` naming is already the convention (`CUSTOMIZING-AUTH-UI.md` documents
`authenticator-action-signIn:google` as public API).

### 4.3 The `RawRoute` surface

All explicit paths under `BLOCKS_AUTH_PREFIX`; per-provider routes generated by iterating the
configured providers with `encodeURIComponent(id)`. **No wildcards and no root route**, so AGENTS.md
rule 12 is satisfied by construction, and `core/src/hosting.ts` already proxies the whole subtree
with a single CloudFront behavior (F6).

| Construct id | Method | Path | Behaviour |
|---|---|---|---|
| `auth-signin-<id>` | GET | `/aws-blocks/auth/signin/<id>` | `getSignInUrl()` → 302 + pending cookie |
| `auth-callback` | GET | `/aws-blocks/auth/callback` | relay-aware dispatcher → 302 `postSignInPath`, or 302 to the relay target, or a 4xx JSON body |
| `auth-signout` | POST | `/aws-blocks/auth/signout` | 204, clears session + pending cookies |
| `auth-exchange` | POST | `/aws-blocks/auth/exchange` | browser-PKCE code exchange → 200 `ExchangeResult` |
| `auth-authorize-params-<id>` | GET, POST | `/aws-blocks/auth/authorize-params/<id>` | POST returns a signed `state` for native/relay clients |
| `auth-refresh` | POST | `/aws-blocks/auth/refresh` | **only when `allowBearerAuth`** |
| `auth-idp-<id>/*` | — | `/aws-blocks/auth/idp/<id>/…` | **mock only** — the stub IdP's 7 routes (§7.2) |

The callback dispatcher's `CallbackResult` tagged union
(`server-exchange | relay | relay-error | error`) is carried over as-is; it is well-tested and its
error codes (`invalid_state`, `sdk_outdated`, `invalid_relay`, `invalid_callback`) are on the wire for
native SDKs.

**Three sign-in transports must keep working** and all three are preserved: server-initiated (302
chain + signed pending cookie), browser PKCE (`sessionStorage` + `/exchange`), and relay (HMAC-signed
`state` envelope + custom-scheme 302 for native apps).

### 4.4 Coexistence with JSON-RPC

They never collide: `registerRoute` hard-bans `/aws-blocks/api*`, the Lambda dispatcher tries
`matchRoute` first and falls through to RPC, and the dev server uses the same registry to decide
whether to serve or proxy to the frontend. The only real coupling is **F7** — the RPC path collapses
multiple `Set-Cookie` headers on AWS. See §7.6.

Note what §4.2 buys here: because federated sign-in is an `AuthAction` with a `url`, the **RPC surface
stays exactly two methods**. `bb-auth-oidc` needed a third (`getClient()`, returning a Transferable)
precisely because it had no way to express "navigate the browser" inside `AuthStateApi` — and that third
method breaks the shared shape (F25). Using the `url` field instead removes the need for it entirely.

### 4.5 `signOut()` must revoke the hosted session too — encoded in the contract

**F21 is a security bug, not an inconvenience.** Cognito's managed-login cookie lives on
`*.amazoncognito.com` and **survives `GlobalSignOut`**. A `signOut()` that only deletes the local
session and clears the local cookie leaves the user able to "sign in" again with no credentials, because
the hosted endpoint silently re-authenticates them. `bb-auth-oidc` has this bug today — it does
server-side session deletion plus back-channel token revocation, and no front-channel logout.

The fix uses the **same** D-005 mechanism as sign-in, so it costs no new concept:

| Session type | `POST /aws-blocks/auth/signout` returns | `signedIn` state's `signOut` action |
|---|---|---|
| native (`signInProvider === 'password'`) | **204**, session deleted, cookie cleared | `{ name: 'signOut', label: 'Sign out', fields: [] }` — plain RPC |
| federated via Cognito | **302** to the pool's `/logout?client_id=…&logout_uri=…`, after deleting the session and clearing the cookie | `{ name: 'signOut', …, url: '/aws-blocks/auth/signout', method: 'POST' }` — the browser follows the redirect chain |
| federated direct | **302** to the IdP's `end_session_endpoint` when discovery advertises one, else 204 | same as above |

So the client does not branch: it submits the `signOut` action, and whether that ends in a 204 or a
redirect chain is the server's business. The server-side `signOut(context)` keeps returning
`Promise<void>` and records the required redirect on `context.response`; the route turns that into a
302. A **sandbox e2e must assert that a second sign-in attempt after a federated `signOut` lands back on
the IdP and is not silently re-authenticated** — this is exactly the class of bug a mock cannot catch.

### 4.6 "Config changes the client's types" is a tested invariant, not a happy accident

`AuthCognito<const O>` + `GroupOf<O>` / `AttrOf<O>` / `MfaTypeOf<O>` already give AWS Blocks something
better-auth, Auth.js, Clerk and Amplify all lack: **the backend configuration narrows the types the
frontend sees.** Amplify's `nextStep.signInStep` union is identical no matter what you configured;
here, `groups: ['admins']` makes `requireRole`'s argument `'admins'`, and `oidcProviders: { okta: … }`
makes `getSignInUrl`'s argument `'okta'`.

That is the framework's differentiator, so this design treats it as a **protected invariant with a
test**, not an incidental property. `types-test.ts` must assert, with `@ts-expect-error`:
mis-spelled group rejected; mis-spelled provider id rejected; unconfigured MFA factor rejected;
unconfigured custom attribute rejected; native method rejected under `emailPassword: false`;
federated method rejected with no providers; and a `takesWide(auth: Auth)` variance guard. These run
under `tsc --build`, so they gate every PR.

---

## 5. The client-side story

### 5.1 What the frontend imports

```ts
// the backend's types, no codegen
import { authApi, api } from 'aws-blocks';
// the renderer + the notifier
import { Authenticator, AuthenticatedContent, AccountMenuBar, onAuthChange, submitAuthAction }
	from '@aws-blocks/blocks/ui';

document.body.appendChild(Authenticator(authApi));          // batteries included
const stop = onAuthChange(authApi, (user) => render(user)); // reactivity
await submitAuthAction(authApi, { action: 'signIn', username, password });  // custom forms
```

### 5.2 The session is **plain data**, not a Transferable

**Recommendation: do not make the session or user a Transferable.** A session is *data* the caller
reads, which G2 says must be a plain object; a Transferable is for *capabilities* (G15). Making it
Transferable would require client middleware to hydrate it, break SSR and the three native clients
(which have no middleware runner), and gain nothing — there is no client-side method to call on a
session that `authApi` does not already expose.

**Corollary — drop `AuthOIDC.getClient()`.** That is the one auth Transferable today
(`__blocks: 'oidc/client'`), and it is the weakest part of the current surface: its hydrated object
is a plain bag of functions that *drops* the `toJSON()` its declared type promises, the descriptor
`toJSON()` emits is **wider** than the declared `OIDCClientDescriptor`, and building it calls
`getAuthorizeParams` once **per provider per call** (N discovery-backed round trips). Everything it
provides is already covered by the `url`-bearing actions (§4.2) plus `submitAuthAction`. This is a
**breaking change for `test-apps/comprehensive`'s frontend**, which does
`const auth = await oidcAuthApi.getClient()`. Flagged for maintainer review.

### 5.3 Reactivity

Adopt `fix/auth-reactivity-185`'s `submitAuthAction()` (F9) as the **documented default and the only
notifier**, and keep its two-tier semantics, which are load-bearing:

- `retriable === true` → return, touch nothing (the form stays on screen with its hidden `session`).
- mid-flow challenge states → advance the private per-`api` cache only (form advances, gated UI does not).
- `signedIn` / `signedOut` → also `broadcastAuthChange` (BroadcastChannel + same-window event).

Three constraints the unified block must respect:
1. Keep `setAuthState` a **pure, Node-safe RPC**. It runs server-side too (cookie-jar scripts); a
   broadcast inside it is a layer inversion.
2. **Exactly one notifier per transition.** The unified block must not add its own broadcast bridge
   (as `fix/issue-79-onauthchange-bridge` and `fix/bb-auth-oidc-3-broadcast-bridge` do for OIDC
   today) or it double-fires with the shared helper. Those two branches are **subsumed**, not merged.
3. The cache is a `WeakMap` keyed by the `AuthStateApi` **object identity**. Never hand out a fresh
   api object per call or the subscriber fan-out silently splits.

**Proposed improvement (OPEN DECISION 5):** also export a real store —
`subscribeAuthState(api, cb): () => void` + `getAuthStateSnapshot(api): AuthState | null` — so React
can use `useSyncExternalStore` instead of the current `useEffect` + `useState` dance. This is the
natural generalization of what #208 patched around, and it is what the #185 investigation
recommended.

---

## 6. Error taxonomy

### 6.1 The unified constant

One `AuthErrors` as-const. Values keep Cognito's wire names wherever one exists (G6: familiar,
googleable), and the OIDC/flow errors keep their `*Exception` suffix for consistency.

```ts
export const AuthErrors = {
	// ── session / authorization ────────────────────────────────────────────────
	NotAuthenticated: 'NotAuthenticatedException',
	NotAuthorized: 'NotAuthorizedException',
	PasswordResetRequired: 'PasswordResetRequiredException',
	TokenExpired: 'TokenExpiredException',
	/** Session is valid but older than `session.freshAgeSeconds`; only from `{ fresh: true }`. */
	ReauthenticationRequired: 'ReauthenticationRequiredException',   // NEW

	// ── sign-up / users ───────────────────────────────────────────────────────
	UserAlreadyExists: 'UsernameExistsException',
	UserNotConfirmed: 'UserNotConfirmedException',
	/** Privileged (`auth.admin`) paths only — never surfaced on a public action. */
	UserNotFound: 'UserNotFoundException',
	AliasExists: 'AliasExistsException',
	UnsupportedUserState: 'UnsupportedUserStateException',

	// ── credentials / codes ───────────────────────────────────────────────────
	InvalidPassword: 'InvalidPasswordException',
	CodeMismatch: 'CodeMismatchException',
	ExpiredCode: 'ExpiredCodeException',
	InvalidParameter: 'InvalidParameterException',

	// ── MFA ───────────────────────────────────────────────────────────────────
	MFAMethodNotFound: 'MFAMethodNotFoundException',
	SoftwareTokenMFANotFound: 'SoftwareTokenMFANotFoundException',
	EnableSoftwareTokenMFA: 'EnableSoftwareTokenMFAException',

	// ── passkeys / WebAuthn ───────────────────────────────────────────────────
	WebAuthnNotEnabled: 'WebAuthnNotEnabledException',
	WebAuthnOriginNotAllowed: 'WebAuthnOriginNotAllowedException',
	WebAuthnRelyingPartyMismatch: 'WebAuthnRelyingPartyMismatchException',
	WebAuthnChallengeNotFound: 'WebAuthnChallengeNotFoundException',
	WebAuthnCredentialNotSupported: 'WebAuthnCredentialNotSupportedException',
	WebAuthnClientMismatch: 'WebAuthnClientMismatchException',
	WebAuthnConfigurationMissing: 'WebAuthnConfigurationMissingException',

	// ── federation / redirect flow ────────────────────────────────────────────
	ProviderNotConfigured: 'ProviderNotConfiguredException',
	ProviderMisconfigured: 'ProviderMisconfiguredException',   // NEW
	IdpError: 'IdpErrorException',
	InvalidState: 'InvalidStateException',
	InvalidCallback: 'InvalidCallbackException',
	InvalidRelay: 'InvalidRelayException',
	SdkOutdated: 'SdkOutdatedException',

	// ── mode gates (runtime backstop for untyped callers) ─────────────────────
	EmailPasswordNotEnabled: 'EmailPasswordNotEnabledException',   // NEW
	NoFederatedProvider: 'NoFederatedProviderException',           // NEW

	// ── throttling / service ──────────────────────────────────────────────────
	LimitExceeded: 'LimitExceededException',
	TooManyRequests: 'TooManyRequestsException',
	TooManyFailedAttempts: 'TooManyFailedAttemptsException',
	GroupNotFound: 'ResourceNotFoundException',   // deliberate non-1:1, carried over
	InvalidLambdaResponse: 'InvalidLambdaResponseException',
	UserLambdaValidation: 'UserLambdaValidationException',
	InternalError: 'InternalErrorException',
} as const;
export type AuthErrorName = (typeof AuthErrors)[keyof typeof AuthErrors];
```

Construction is always `new ApiError(message, status, { name, cause?, retriable? })`. Matching is
`isBlocksError(e, AuthErrors.X)` on the throw path and `hasAuthError(state, AuthErrors.X)` on the
`setAuthState` path. HTTP mapping and `isRetriableAuthError()` carry over unchanged
(401 / 404 / 409 / 429 / 400-default; retriable = `CodeMismatch | EnableSoftwareTokenMFA |
InvalidParameter | InvalidPassword`, fail-closed for everything else).

### 6.2 Mapping every existing error

| Source | Existing | Unified | Note |
|---|---|---|---|
| **Cognito** | all 29 constants | **kept verbatim** (keys and values) | zero churn for the largest surface |
| **Basic** | `InvalidCredentials: 'InvalidCredentialsException'` | **→ `NotAuthorized`** | same condition; Cognito's name wins. Renamed. |
| Basic | `UserAlreadyExists: 'UserAlreadyExistsException'` | **→ `UserAlreadyExists: 'UsernameExistsException'`** | key kept, **value changes** |
| Basic | `InvalidCode: 'InvalidCodeException'` | **→ `CodeMismatch`** | Cognito splits mismatch vs. expiry; more precise |
| Basic | `SessionExpired: 'SessionExpiredException'` | **→ `NotAuthenticated`** | **see §6.4** |
| Basic | `InvalidPassword` | unchanged | identical key and value |
| **OIDC** | all 8 constants | **kept** | `TokenExpired` is never *thrown* but is on the wire in the `/refresh` 401 body, so it stays |
| OIDC | `AuthOIDCConfigError`, `RelayConfigError` (plain `Error`) | **stay unnamed plain `Error`** | construction-time config mistakes; D-AB-10 |
| OIDC | `AuthOIDCEngineError` (plain `Error`, ~8 messages) | **folded into** `ProviderNotConfigured` / `InvalidState` / `InvalidCallback` / `IdpError` | today the entire Cognito federation path is outside the taxonomy, so `isBlocksError` never matches — a real bug this fixes |

**Dropped:** `InvalidCredentialsException`, `UserAlreadyExistsException`, `InvalidCodeException`,
`SessionExpiredException` (all four are AuthBasic-only). Each rename breaks a caller:
`test-apps/comprehensive/test/basic-auth.test.ts` hardcodes all five AuthBasic names as **local
string literals** (not imports), and the Kotlin/Swift native e2e suites assert on thrown names.

### 6.3 User-enumeration safety — the explicit rules

`preventUserExistenceErrors: true` is already in main (F8). It is necessary and **not sufficient**.

1. **Sign-in is uniform.** Unknown username, wrong password, and disabled user must produce a
   byte-identical response: `NotAuthorizedException`, HTTP **401**, message
   `"Incorrect username or password"`, `retriable` absent, and identical `errorName`. The mock is
   already the reference implementation here; the AWS path relies on the pool-client setting.
   > `errorName` is machine-readable on the wire, so **any per-flow divergence in `errorName` is
   > itself an oracle** even when the human-readable `error` string is uniform.
2. **Password reset always reports success**, with plausible `codeDeliveryDetails` for unknown users
   (the mock fabricates `'------'`). Never throw `UserNotFound` on a public path.
3. **Assert at both layers**: a CDK synth test for `PreventUserExistenceErrors: 'ENABLED'`, and mock
   tests for 1–2, so local↔AWS parity holds.
4. **Close the two residual gaps** (F8), which PR #293 did not:
   - *Parity inversion:* the mock's `resendSignUpCode`, `confirmResetPassword`, and the challenge
     path call `requireUser()` → `UserNotFound`/404, and all three are reachable public
     state-machine actions. AWS masks them via `PreventUserExistenceErrors`, so **the mock is
     currently leakier than AWS.** Fix the mock to match.
   - *`signUp` reveals existing users:* `UsernameExistsException`/409 on **both** runtimes, and
     `PreventUserExistenceErrors` does not mask sign-up. This is a first-class vector for any app
     with self-registration. **Recommendation:** keep the imperative `auth.signUp()` throwing
     `UserAlreadyExists` (server-side callers are inside the trust boundary), but make the **public
     `setAuthState({action:'signUp'})` path** return a uniform `confirmingSignUp` state without
     revealing — the standard mitigation, since Cognito cannot do it natively. This changes
     observable behaviour → OPEN DECISION 7.
5. `UserNotFound` remains legitimate **only** inside `auth.admin.*`. Keep that split explicit and
   test it.

### 6.4 The 401 name conflict — pick `NotAuthenticatedException`

`auth-common`'s `BlocksAuth` JSDoc documents `SessionExpiredException`. Only `AuthBasic` honors it;
Cognito and OIDC both throw `NotAuthenticatedException`. Neither `AuthCognitoErrors` nor
`AuthOIDCErrors` even has a `SessionExpired` key.

**Recommendation: `NotAuthenticatedException`** — two of three implementations, and
`test-apps/comprehensive/test/sandbox-admin-e2e.ts` already asserts it. `basic-auth.test.ts` must
change, and **the `BlocksAuth` JSDoc must be corrected either way** — it is wrong today.

### 6.5 Every other name collision, listed as a breaking change

AGENTS.md rule 6 makes error `name` a public contract, so each of these needs maintainer sign-off
rather than a quiet pick. Consolidated list, with the recommendation and who breaks:

| Collision | Recommended winner | Why | Who breaks |
|---|---|---|---|
| 401 name: `SessionExpiredException` (Basic) vs `NotAuthenticatedException` (Cognito, OIDC) | **`NotAuthenticatedException`** | 2 of 3 implementations; already asserted by the sandbox e2e | `basic-auth.test.ts`; the `BlocksAuth` JSDoc (already wrong) |
| `UserAlreadyExistsException` (Basic) vs `UsernameExistsException` (Cognito) | **`UsernameExistsException`** | it is the real Cognito wire name (G6) | `basic-auth.test.ts`; Kotlin/Swift e2e |
| `InvalidCredentialsException` (Basic) vs `NotAuthorizedException` (Cognito) | **`NotAuthorizedException`** | same condition; Cognito's name is what the service emits | `basic-auth.test.ts` |
| `InvalidCodeException` (Basic) vs `CodeMismatchException` + `ExpiredCodeException` (Cognito) | **Cognito's pair** | strictly more precise — expiry and mismatch are different user fixes | `basic-auth.test.ts` |
| `passwordPolicy.requireSpecialChars` (Basic) vs `requireSymbols` (Cognito) | **`requireSymbols`** | matches Cognito's `RequireSymbols`; avoids a second name for one service field | every `AuthBasic` app that sets it, incl. the `default`/`react`/`demo` templates |
| `codeDelivery: (username, code)` (Basic) vs `(username, code, purpose)` (Cognito) | **the 3-arg form** | `purpose` is needed to route sign-up vs reset vs MFA vs attribute codes; 2-arg callbacks remain assignable to a 3-arg signature, so **this one is source-compatible in the common direction** | only code that *declares* all three params and relies on arity |
| `userId` semantics: username (Basic, Cognito) vs `` `${iss}:${sub}` `` (OIDC) | **username**, with `userSub` as the stable key | see §3.1 and OPEN DECISION 6 | anything keyed on an `AuthOIDC` `userId` |

---

## 7. Layer-by-layer sketch

### 7.0 Structure: one base class, pluggable engines — not two parallel implementations

This is the biggest structural win available and it should be taken (F26). Today
`bb-auth-cognito/src/index.ts` (2332 lines, mock) and `index.aws.ts` (2465 lines, AWS) are **two
independent classes reimplementing the same 42 methods with no shared base** — every behavioural fix
has to be made twice, and `parity.test.ts`-style tests exist precisely to catch the drift that
structure guarantees. `bb-auth-oidc` already demonstrates the alternative working in this repo: a
shared base class plus an injected engine, with **169-line** entry files.

```
AuthBase  (extends Scope, implements BlocksAuth)
  ├─ owns: session cookie + session store, AuthState builders, createApi(), RawRoute mounting,
  │        requireAuth / requireRole / checkAuth / getCurrentUser, validateUser dispatch,
  │        the mode gates, error mapping
  └─ delegates to:
       NativeEngine          — signUp / signIn / confirmSignIn / MFA / passkeys / reset
       FederationEngine[]    — per provider: buildSignInUrl, handleCallback, exchange, refresh, logout
```

- `index.mock.ts` → `new AuthBase(…, { native: MockCognitoEngine, federation: StubIdpEngine })`
- `index.aws.ts` → `new AuthBase(…, { native: CognitoSdkEngine, federation: CognitoHostedUiEngine | DirectOidcEngine })`

Two things this buys beyond line count: the session layer is written **once** and is already proven
engine-agnostic (`bb-auth-oidc`'s `SessionManager` is injected into both of its engines), and
**federation-engine selection becomes per-provider instead of per-instance** — which fixes a live bug
where a single `cognitoFederated()` entry silently makes every co-declared `google()`/`stubIdp()`
provider unreachable even though its route exists.

> ⛔ **Prerequisite, not a follow-up.** `bb-auth-cognito/src/index.aws.ts` has only **6 tests that run
> by default** (one of them a pure function); everything else is `BLOCKS_INTEGRATION=1`-gated and
> skipped by `npm test`. There is effectively **no safety net under the AWS layer**, and this refactor
> moves all of it. Closing that gap — command-shape tests against a spied SDK client, in the style of
> `bb-kv-store/src/parity.test.ts` blocks 5–6, plus the sandbox e2e suite — must land **before** the
> base-class extraction, not with it.

### 7.0a File shape

`bb-kv-store` is the layering reference (`bb-realtime`'s single-`index.ts` layout is explicitly not to
be copied):

```
packages/bb-auth/
  README.md  DESIGN.md  CUSTOMIZING-AUTH-UI.md (moved from auth-common)  API.md (generated)
  package.json  tsconfig.json  api-extractor.json
  src/
    version.ts              # GENERATED by prebuild: generate-version.mjs Auth
    types.ts                # TYPES ONLY — `import type` only
    errors.ts               # AuthErrors as-const + isRetriableAuthError
    auth-base.ts            # the shared base class (§7.0)
    state-machine.ts        # pure AuthState builders
    sessions.ts  cookies.ts  routes.ts  relay.ts  state.ts
    engines/native-cognito.ts  engines/native-mock.ts
    engines/federation-hosted-ui.ts  engines/federation-direct.ts  engines/stub-idp.ts
    index.mock.ts  index.aws.ts  index.cdk.ts  index.browser.ts
    index.test.ts  parity.test.ts  index.cdk.test.ts  types-test.ts  admin.types-test.ts
```

### 7.1 `index.aws.ts` — the AWS runtime

Real `CognitoIdentityProviderClient` with `customUserAgent: this.buildUserAgentChain()`, created
lazily (the module is imported during client codegen outside Lambda, so env vars resolve to `''`).
`registerSdkIdentifiers(this.fullId, { userPoolId, clientId })` in the constructor;
**`getSdkIdentifiers(this)` at every call site, never in the constructor.** Reads the session-signing
secret and provider secrets from `AppSetting` (SSM `GetParameter WithDecryption`). Owns token refresh
(`REFRESH_TOKEN_AUTH` + sliding cookie `Max-Age`), `CognitoJwtVerifier` behind a lazy getter, and the
Hosted-UI authorize/token/revoke URLs for federation. Mounts the RawRoutes of §4.3 **minus** the stub
IdP.

### 7.2 `index.mock.ts` — default + types entry

The existing 2332-line Cognito mock (users, groups, codes, challenges, sessions, passkeys persisted
to `.bb-data/{fullId}/state.json` via `getMockDataDir(this)`) **plus** `bb-auth-oidc`'s stub IdP,
repointed. `registerSdkIdentifiers(this.fullId, { userPoolId: 'mock-pool-…', clientId: 'mock-client-…' })`.

**The stub IdP is the single most important thing to carry over.** It is a real, spec-conformant
in-process OIDC provider — RS256 keypair via `jose`, a discovery document, JWKS, `/authorize` (with a
server-rendered account picker), self-contained HMAC-signed authorization codes, `/token` with real
PKCE S256 verification, `/userinfo`, `/revoke`. Without it, `emailPassword: false` has **no offline
sign-in at all** and `npm run dev` is broken for every federated app. Today
`cognitoFederated()` already throws `cognitoUnavailableLocally()` in local dev; the unified block must
not inherit that.

**Concretely, what a federated sign-in does in `npm run dev`** (this is the answer F22 demands, and it
differs by OPEN DECISION 0):

| Provider | Local behaviour |
|---|---|
| `oidcProviders` with `federateVia: 'direct'` | Full-fidelity: `GET /aws-blocks/auth/signin/<id>` 302s to the in-process stub IdP, which serves real discovery + JWKS, does real PKCE S256 verification, and mints a real RS256 ID token. The *same* `DirectOidcEngine` code path runs locally and in production — only the issuer URL differs. This is the grade-A case and it already works today. |
| `oidcProviders` with `federateVia: 'cognito'`, and all `socialProviders` / `samlProviders` | The hosted `/oauth2/authorize` endpoint does not exist locally. **Mitigation: a mock hosted-UI shim** — three additional mock-only routes (`/oauth2/authorize`, `/oauth2/token`, `/logout`) that 302 to the stub IdP, accept its callback, and mint the same synthetic Cognito-shaped tokens the rest of the mock already produces. This is a real but bounded lift (the mock already mints mock ID/access tokens and already owns a user directory), and it is the only way to keep the "no AWS account" promise for these providers. **Without it these providers cannot be exercised locally at all**, and `npm run dev` must at minimum fail with the actionable `cognitoUnavailableLocally()`-style message rather than a confusing 404. |

> This asymmetry is the strongest single argument in **OPEN DECISION 0**: nothing in the prior art
> (better-auth, Auth.js, Clerk, Amplify) can iterate on auth offline. It is AWS Blocks' clearest
> differentiator, and routing generic OIDC through Cognito is the one choice that forfeits it.

### 7.3 `index.cdk.ts` — what it provisions

`class Auth extends BuildingBlockScope`, `super(id, { parent: scope, vpc: { interfaceEndpoints: [SSM] } })`.

| Resource | Notes |
|---|---|
| `cognito.UserPool` (`'pool'`) | `userPoolName: this.fullId`; self-sign-up, sign-in aliases, auto-verify, password policy, MFA + second factors, custom attributes, device tracking, feature plan, passkey RP config, removal policy. Or `UserPool.fromUserPoolId` when wrapping. |
| `cognito.UserPoolClient` (`'client'`) | `generateSecret: false`, **`preventUserExistenceErrors: true`**, `authFlows` per `users.authFlow`. `disableOAuth: true` **only when no federated provider** — otherwise OAuth code grant + real callback/logout URLs. |
| `cognito.CfnUserPoolGroup` × N | one per `users.groups` entry |
| `cognito.UserPoolDomain` | **only when ≥1 federated provider** |
| IdP registration custom resource | **only when ≥1 federated provider** — a Lambda + `Provider` + one `CustomResource` per provider calling `Create/Update/DeleteIdentityProvider`, reading each secret's SSM parameter. Must `addDependency` on `SECRETS_BULK_CONSTRUCT_ID` so secret seeding runs first. |
| `AppSetting` (`'session-secret'`, secret) | HMAC key for the session cookie and the challenge envelope |
| `KVStore` (`'sessions'`, `{ ttl: true }`) | server-side session records |

Fixes to make while rewriting: the callback URL is a `https://localhost` placeholder today (the real
front-door URL is never wired at synth); `SignInWithApple` is validated as a built-in but synthesized
as `ProviderType: 'OIDC'` and is **silently dropped** when `idpIssuerUrl` is absent.

**`registerConfig` keys** (never `handler.addEnvironment()` — rule 3):

| Key | Value |
|---|---|
| `…_USER_POOL_ID` | `userPool.userPoolId` |
| `…_CLIENT_ID` | `userPoolClient.userPoolClientId` |
| `…_CLIENT_SECRET` | only when a federated client needs a secret |
| `…_REGION` | `Stack.of(this).region` |
| `…_DOMAIN` | the Cognito domain, **only when federation is enabled** |
| `…_SESSION_SECRET_PARAM` | SSM parameter *name* for the session secret |

Drop `_REGION`/`_DOMAIN` if they stay unread — both are written and never read in `bb-auth-oidc` today.

**IAM**: statement 1 (always) = the 24 client actions on the pool ARN; statement 2 (only when
`options.admin`) = the `Admin*`/`List*` set scoped by `admin.actions`. Grant to
`this.executionRole` — **the shared role** — not to a function.

**`synthGuard` stubs for every runtime method.** Neither `bb-auth-cognito` nor `bb-auth-oidc` uses
`synthGuard` today; their CDK classes simply omit the methods. That looks equivalent but is worse:
shared IFC code typechecks against the **`types`** condition (which resolves to the *mock*), so a
top-level `auth.signIn(…)` compiles and then fails at synth with a bare
`TypeError: auth.signIn is not a function`. `synthGuard('Auth', 'signIn')` yields the actionable
message instead. This is a concrete improvement, and AGENTS.md requires it.

### 7.4 `index.browser.ts` — the browser stub

Re-exports every type plus `AuthErrors`; a class whose methods throw `'…is server-side; call the
generated client'`; a throwing `get admin()`; `createApi()` returning an `ApiNamespace` whose methods
throw. It must be a **named-export superset of the default entry** — `conditional-exports.test.ts`
(in `packages/blocks`) only checks `aws-runtime ⊇ default`, but AGENTS.md requires parity across all
four, and a browser-entry test must assert it does **not** import `./index.mock.js`
(the bundle-hygiene invariant `bb-auth-basic` already tests, keeping bcrypt/jsonwebtoken and now the
Cognito SDK out of browser bundles).

### 7.5 Where mock and AWS must diverge

| Aspect | Mock | AWS | Mitigation |
|---|---|---|---|
| **Federation transport** | in-process stub IdP (`/aws-blocks/auth/idp/<id>/*`) | Cognito Hosted UI (`/oauth2/authorize`, `/token`, `/revoke`) | **The largest gap.** A sandbox e2e per transport is mandatory. |
| Real IdP in dev | a non-stub provider hits the real IdP even in `npm run dev` | — | Log a startup banner naming each provider's resolved target (exists today) |
| TOTP | any 6-digit code accepted | real `VerifySoftwareToken` | documented; sandbox e2e with `totpNow()` |
| Passkeys | loose match on `id`/`rawId`, no CTAP signature check | real WebAuthn | avoids a `@simplewebauthn/server` dependency; documented |
| Passwords | **plaintext** in `.bb-data/{fullId}/state.json` | Cognito-managed | `.bb-data` is gitignored; README must say "local only" |
| Codes | also written to `.bb-data/{fullId}/last-code.json` | delivered by Cognito | that file is how `npm run dev` is usable |
| Token refresh | no refresh concept; expired ⇒ delete + clear cookie | `REFRESH_TOKEN_AUTH` + sliding cookie | mock re-mints synthetic JWTs on `forceRefresh` |
| JWTs | `alg: 'none'`, `mock-signature` | real RS256 | real `decodeIdToken`/`jwtExpMs` still parse them |
| Cookie attributes | `isLocalhost: true` ⇒ `SameSite=Lax` | `Lax; Secure` | shared `resolveCookieSecurity` (D-007) + the cross-BB parity test |
| Cookie name prefix | **`_`-joined** | **`-`-joined** | **Fix: pick one.** Today sessions don't survive a mock↔aws switch. |
| `revokeUserSessions` | deletes session records | only revokes refresh tokens | documented parity gap |
| `allowInsecureIssuers` | `true` (HTTP JWKS accepted) | `false` | required for the stub IdP over HTTP |

### 7.6 Two cross-cutting bugs to fix while here

- **F7 — multi-cookie loss on the RPC path.** `lambda-handler.ts` builds RPC responses with
  `Object.fromEntries(responseHeaders.entries())`, which keeps only one `Set-Cookie`; only the
  RawRoute path emits `multiValueHeaders`. Cognito sets the session cookie with `headers.set` and the
  encrypted autoSignIn bridge cookie with `headers.append`, so on AWS one of them is silently
  dropped when both are set in one RPC response. The dev server *does* split correctly, so this
  cannot reproduce locally. **Fix in `core`, and add a sandbox e2e** — this is exactly the class of
  bug AGENTS.md warns mock tests cannot catch.
- **`core/src/redact.ts` is keyed to auth field names.** `SENSITIVE_KEY_PARTS` plus an exact match on
  `'code'` and a special rule for `AuthField` descriptors (`{name:'session', defaultValue:'<token>'}`
  → redact the sibling `defaultValue`). **Renaming any auth action or field silently un-redacts
  secrets from logs.** Any field rename needs a matching `redact.ts` change and a test.

### 7.7 Consolidation targets and migration hazards

**One cookie module.** `bb-auth-cognito/src/cookies.ts` reads cookie values with an anchored,
`escapeRegex`'d pattern (`(?:^|;\s*)`) plus `constantTimeEquals` for the HMAC. `bb-auth-basic` reads
them with `cookies.match(new RegExp(\`${cookieName}=([^;]+)\`))` — **unanchored and unescaped**, so a
lookup for `auth_foo` is satisfied by `my_auth_foo=…`. Promote Cognito's module; the AuthBasic reader
must not survive the merge. `auth-common/cookies` keeps owning the `SameSite`/`Secure`/`Partitioned`
matrix (D-007) and should additionally absorb name construction and signing, which are per-BB today —
that triplication is exactly what let the three blocks drift in the first place.

**The cookie name collides with incompatible payloads (F27).** `bb-auth-basic` and `bb-auth-cognito`
both use `auth_${fullId}`, carrying an HS256 JWT and an HMAC'd session id respectively. An app migrating
from `AuthBasic` at the same scope id will send a stale JWT to the unified block's session verifier.
Required behaviour: HMAC verification fails → treat as **no session** → return `null` / clear the
cookie. Never throw, never 500. **Add an explicit test with a real AuthBasic-format cookie**, because
"signed out" is the correct outcome and it is easy to regress into a crash.

**One `User` type.** Four types disagree today (`AuthUser`, `AuthBasicUser`, `CognitoUser<O>`,
`OIDCUser` — the last does not even extend `AuthUser`), and `userId` variously means the username,
`sub`, or `${iss}:${sub}`. §3.1 collapses them to `AuthUser` (wire) + `AuthenticatedUser<O>` (server),
with `userSub` as the one stable key. The migration consequence is spelled out in OPEN DECISION 6.

**Fix the umbrella export asymmetry.** `packages/blocks` re-exports ~30 Cognito types and **4** OIDC
types, and every OIDC provider type is flagged `ae-forgotten-export` by API Extractor — structurally
reachable but never exported. That asymmetry is part of why users read Cognito as the "real" block. The
unified block must export its full public type surface from **both** `index.ts` and `index.cdk.ts`, and
those two lists must be mirrored deliberately: `conditional-exports.test.ts` compares only **value**
exports (`Object.keys(m)`), so type-only drift between the default and `cdk` entries is invisible to CI.
The CDK re-export list is already narrower than the default one today.

---

## 8. Self-review against G1–G18 and the AGENTS.md core rules

### G1–G18

| # | Guideline | Complies | Note |
|---|---|---|---|
| G1 | Options object over positional | **Yes** | `(scope, id, options?)`; every method takes required args then an options object. The `...gate` rest tuple is a type-level artifact that erases to nothing at runtime. |
| G2 | Client-safe return types | **Yes** | All returns are plain JSON data. §5.2 deliberately **removes** the one existing Transferable. |
| G3 | `null` for absence, throw for failure | **Yes** | `getCurrentUser` → `null`; `admin.getUser` → `null`; `require*` throws. `resetPassword` returns success for unknown users by design (§6.3). |
| G4 | Async by default | **Yes** | Everything is `Promise` or `AsyncIterable`. |
| G5 | `AsyncIterable` for unbounded sets | **Yes** | `admin.scan()`, `scanDevices()`. |
| G6 | Typed error constants | **Yes** | One `AuthErrors`; Cognito wire names kept; `GroupNotFound → ResourceNotFoundException` is a deliberate documented non-1:1. |
| G7 | Constructor is the only side effect | **Yes** | Pool, client, groups, domain, IdP resources, session table, secret, RawRoutes, `registerConfig`, IAM — all in the constructor. |
| G7a | Runtime methods must not run at construction | **Yes, improved** | §7.3 **adds** the `synthGuard` stubs that both current blocks lack. |
| G8 | Narrow types over broad | **Mostly** | Closed unions for modes/factors/flows; `ProviderIdOf<O>` narrows provider ids; `ProfileAttributeMapping` closes off identity keys with `never`. `oidcProviders` is `Record<string, …>` because provider ids are user-chosen. Create-only properties (F17) cannot be expressed in the type system at all — they are handled by a synth-time refusal (§2.5), which is the best available. |
| G9 | `fromExisting()` returns a reference | **Yes** | `Auth.fromExisting(userPoolId, clientId?) → ExternalUserPoolRef` (branded), passed as `options.userPool`. |
| G10 | No leaking AWS primitives | **Yes** | No SDK types, no ARNs, no pool ids in public signatures. `getSdkIdentifiers(auth)` remains the deliberate, typed escape hatch. |
| G11 | Document everything agents need | **Yes** (obligation) | The JSDoc above is illustrative; the implementation PR must ship full `@param`/`@returns`/`@throws`/`@example` on every public method plus class-level *when to use / when not / best practices / scaling*, mirrored in `README.md`. |
| G12 | Avoid overloads | **Partial — worth review** | Three `boolean \| Options` unions (`emailPassword`, `passkeys`, `mfa`) and `MfaMode \| MfaOptions`. These are *option-value* unions, not overloads, and they buy the one-liner. But `AuthCognito` ships two genuine overload pairs today (`signUp`, `confirmSignUp`, `confirmSignIn`) — **this design collapses them** into one signature with a trailing optional `context`, which is a G12 improvement. |
| G13 | `Scope` extends, not wraps | **Yes** | `extends Scope` / `extends BuildingBlockScope`. |
| G14 | Method naming | **Partial — deliberate renames** | `require*`/`check*`/`getCurrent*` are exactly per spec. G14 says **avoid `fetch`, use `get`**, and today's surface violates it four times, so this design renames `fetchAuthSession → getAuthSession`, `fetchUserAttributes → getUserAttributes`, `fetchMFAPreference → getMfaPreference`, `fetchDevices → scanDevices`. That trades Amplify-v6 familiarity for guideline compliance → **OPEN DECISION 8**. `signIn`/`signUp`/`confirmSignUp` are outside G14's vocabulary and are frozen by the wire contract. |
| G15 | Transferables for live client objects | **N/A, deliberately** | §5.2: nothing auth returns is a capability. |
| G16 | Accept `StandardSchemaV1` | **N/A** | No user-supplied validation schema. If custom-attribute validation is ever added it must take `StandardSchemaV1`. |
| G17 | BB-produced namespaces use `createApi()` | **Yes** | `createApi(): AuthStateApi`, no parameters, customer exports the result. |
| G18 | Don't expose options that misrepresent cost | **Yes, and extended** | `admin.scan(filter?)` maps to a real Cognito `ListUsers` `Filter` (server-side), so the option genuinely reduces work. Beyond the letter of G18, §2.2 applies its *spirit* to **money**: the `socialProviders` / `oidcProviders` split makes the 200× MAU free-tier cliff (F14) visible at the call site instead of hiding it behind two adjacent config lines, and `featurePlan`'s JSDoc states outright that it is a pricing decision (F18). **Worth backporting into G18 as a clarification** — "cost" should mean dollars as well as latency. |

### AGENTS.md core rules

| # | Rule | Complies | Note |
|---|---|---|---|
| 1 | Synth with `--conditions=cdk` | **Yes** | Four entry points with a `cdk` condition. |
| 2 | State only through Building Blocks | **Yes** | Users/groups → Cognito; sessions → `KVStore`; secrets → `AppSetting`. The mock's `.bb-data` files go through `getMockDataDir`. |
| 3 | `registerConfig`, never `addEnvironment` | **Yes** | §7.3; ~6 keys. |
| 4 | Data methods only in handlers | **Yes** | Plus `synthGuard` stubs (G7a). |
| 5 | Never attach `Error.cause` enumerably | **Yes** (obligation) | `ApiError`'s `super(message, { cause })` is spec-non-enumerable. Any post-hoc attach must use `Object.defineProperty(..., { enumerable: false })` per `bb-knowledge-base`, with the "absent from `JSON.stringify`" test. **Critical here** — Cognito SDK errors carry `$metadata`. |
| 6 | Errors cross by `name` | **Yes** | `AuthErrors` + `isBlocksError` (throw path) and `hasAuthError` (state path). Only `message`, `status`, `name`, `retriable` cross the wire. |
| 7 | `get()` returns `null` for not-found | **Yes** | See G3. |
| 8 | No casts in customer-facing code | **Yes, improved** | `const O` + `ProviderIdOf<O>` removes `test-apps/comprehensive`'s existing `role as Parameters<typeof authC.requireRole>[1]` cast. One internal cast remains — the `return this.#admin as AdminGetterOf<O>` getter, already proven not to widen away safety (admin plan Appendix B). |
| 9 | Gate every API method with `requireAuth` | **N/A→provides** | This BB *is* the gate. Its own `createApi()` methods are intentionally unauthenticated (sign-in cannot require a session) — which makes §6.3's enumeration rules the load-bearing protection on that surface. |
| 10 | Changeset for every published package | **Yes** (obligation) | Must cover `bb-auth`, `auth-common`, `blocks`, `core`, `create-blocks-app`, and the three removed packages. |
| 11 | Keep docs runnable | **Yes** (obligation) | Also: **fix the two stale reference docs (F12)** — they will actively mislead the implementer. |
| 12 | No root route; wildcard last | **Yes** | Zero wildcards, zero root routes; everything explicit under `/aws-blocks/auth/`. |
| 13 | Call it "AWS Blocks" | **Yes** | Also fixes the mock banner, which says `Blocks stub IdP` while the README says `AWS Blocks stub IdP`. |

**Where this proposal is weakest, stated plainly:**
1. **OPEN DECISION 0 is unresolved, and everything downstream depends on it.** If it lands on (a),
   §7.2 gains a mock hosted-UI shim as required work and the framework's offline-dev promise is
   materially weaker for federated apps.
2. **G12**, on the three `boolean | Options` unions. Defensible (they are what makes `mfa: 'optional'`
   and `emailPassword: false` read well) but it is a real judgment call, not a clean pass.
3. **G14**, on the four `fetch*` renames — guideline-compliant but breaking and hostile to
   Amplify migrators. OPEN DECISION 8.
4. **§3.5's type gate is unproven in this exact shape.** The *technique* is proven (`auth.admin`
   ships it with a variance guard); this *application* of it is not. The types-test must land first.
5. **The mock↔AWS federation gap (§7.5) is the largest parity risk in the design** and cannot be
   closed by unit tests.
6. **The base-class refactor (§7.0) moves 2,465 lines of AWS code that has 6 default-run tests.** The
   test gap is a hard prerequisite; treating it as a follow-up would be reckless.
7. **`validateUser` expands the block's scope to owning a Cognito trigger Lambda** (OPEN DECISION 11),
   which `bb-auth-cognito/DESIGN.md` currently rules out.
8. **The design cannot make `signInWith` / `attributes` safely changeable** (F17). The best available
   outcome is a clear synth-time refusal; a customer who needs a different username scheme still faces
   a new pool and a user migration.

---

## OPEN DECISIONS

### OPEN DECISION 0 (central) — which engine actually performs generic-OIDC federation?

This is the highest-value decision in the workstream and it is upstream of everything else in this
document. It is **not** a re-litigation of "Cognito as the engine" — Cognito remains the sole user
directory, the sole native-auth implementation, and the sole path for social and SAML providers under
every option below. The question is narrower: **when a customer writes
`oidcProviders: { okta: … }`, does the redirect go browser → Cognito → Okta → Cognito → app, or
browser → Okta → app?**

`03-cognito-capabilities.md` §8.1 finds via-Cognito worse on **six axes and better on zero** for the
target user (cost, local dev, claim fidelity, network hops, UI control, provider compatibility), with
the security argument for it being factually wrong (F15). I have checked that analysis against the
repo and agree with its substance, with one correction: it undercounts **unified identity** as a win
(see (a) below).

| | (a) OIDC via Cognito | (b) OIDC direct, Cognito for native only | (c) Both, per-provider `federateVia` |
|---|---|---|---|
| **Holds "solely Cognito" literally** | ✅ | partly | partly |
| **Cost for generic OIDC** | ❌ 50 free MAU, then $0.015/MAU | ✅ $0 | ✅ $0 by default |
| **Works in `npm run dev` offline** | ❌ grade F — needs a new mock hosted-UI shim (§7.2) to work at all | ✅ grade A — already works today via the stub IdP | ✅ grade A by default |
| **PKCE-only / public-client IdPs** | ❌ impossible (F16) | ✅ | ✅ |
| **Claim fidelity** | ❌ mapped attributes only; multi-valued claims mangled (F20) | ✅ raw ID token | ✅ |
| **Federated users get pool groups + `auth.admin` + account linking** | ✅ | ❌ no pool record | ✅ opt in per provider |
| **Engines to maintain** | 1 federation engine | 2 (hosted-UI for social/SAML + direct for OIDC) | 2, same as (b) |
| **New code** | mock hosted-UI shim | none — both engines exist today | none, plus per-provider selection |

**Recommendation: (c), with `federateVia` defaulting to `'direct'` for `oidcProviders`;
`socialProviders` and `samlProviders` always federate via Cognito.**

Reasoning:
1. **(b) is not actually simpler than (c).** SAML has no direct implementation in this repo and social
   providers are *cheap* via Cognito (they share the 10,000-MAU tier) **and** get pool records — so
   Cognito-mediated federation has to exist regardless. Both engines ship in either case. (c) is (b)
   plus one option, and the option is what buys back the only thing (b) loses.
2. **Per-provider selection is also a bug fix.** Engine choice is per-*instance* today, so one
   `cognitoFederated()` entry silently makes every co-declared `google()`/`stubIdp()` provider
   unreachable while its route still exists. Moving the decision to the provider fixes that.
3. **Offline iteration is the differentiator.** Nothing in the prior art — better-auth, Auth.js,
   Clerk, Amplify — can iterate on auth offline. Making the *default* for generic OIDC the one choice
   that forfeits it would trade away our clearest advantage for a capability (unified pool identity)
   that most federation-only apps do not use.
4. **The defaults encode the cost cliff.** A customer who writes the obvious thing gets the free,
   locally-runnable path. Opting into the $0.015/MAU path is explicit and one word long.

**What (c) costs, stated plainly.** A direct-federated user has no Cognito record, so
`AuthenticatedUser.groups` would be empty and `auth.admin` would not see them — an observable asymmetry
*within one block*, which is exactly the kind of inconsistency this refactor is supposed to remove.
**Mitigation:** give `OidcProviderOptions` a `groupsClaim?: string` so `requireRole()` resolves groups
from the IdP's claim for direct providers, and document `auth.admin` as operating on the Cognito
directory only (which it already does). With that, the only remaining asymmetry is admin lifecycle over
federated users — and Cognito's admin APIs largely refuse to operate on federated users anyway.

**If the maintainer prefers (a)** to hold the "solely Cognito" line, these become mandatory rather than
optional: build the mock hosted-UI shim (§7.2) or the "runs locally" promise breaks for every federated
app; keep the 200×-pricing warning in the `oidcProviders` JSDoc; and document that PKCE-only IdPs are
unsupported. I would not recommend (a) without the shim.

*(OPEN DECISION 4 below — "do we keep a non-Cognito federation path at all" — is subsumed by this
decision. Resolve this one; 4 follows from it.)*

---

**1. Class and package name.** `Auth` / `@aws-blocks/bb-auth` (recommended) vs. keeping `AuthCognito` /
`bb-auth-cognito`. The tension is `origin/feat/bob-auth-jwt`'s `AuthBearerJwt` and
`origin/supabase-auth-poc`'s `AuthSupabase` (F10) — if those ship, is `Auth` + `AuthBearerJwt` +
`AuthSupabase` a coherent family? **Recommendation: `Auth`.** The refactor's purpose is to delete a
choice; a name that still asks "do you want Cognito?" only shrinks the choice from three to two.
*This decision gates everything else in the doc and should be settled first.*

**2. Does `auth-common` survive?** (a) Keep it as the home of the wire contract + `/ui` + `/cookies`
(recommended) — `AuthBearerJwt`/`AuthSupabase` need `BlocksAuth`, `AuthState`, and the renderer
without depending on the Cognito block. (b) Fold it into `bb-auth` and have siblings depend on
`bb-auth` — simpler tree, wrong dependency direction. (c) Fold into `core` — puts `document.createElement`
in the framework core. **Recommendation: (a).** With one block, `AuthenticatorOptions` can *also*
gain a strongly-typed overlay in `bb-auth`, collapsing `cognitoOverrides`.

**3. Provider config encoding.** (a) Three keys — `socialProviders` / `oidcProviders` /
`samlProviders` (recommended; type-safe, mirrors better-auth). (b) One `providers` record with a
required `type` discriminant on every entry — one namespace, no collision check, but `type: 'google'`
under the key `google` is redundant. (c) One record without a discriminant — **unsound**, an unknown
key with a social shape typechecks. (d) `providers: [google({…}), oidc({ id: 'okta', … })]`, an
Auth.js-style factory array — fully type-safe and most extensible, but least declarative.
**Recommendation: (a).**

**4. Bare OAuth 2.0 (GitHub and any `customOauth2` provider).** *Subsumed by OPEN DECISION 0 for the
generic-OIDC case; this is the residue.* GitHub speaks OAuth 2.0 without an ID token, so **no** Cognito
path exists for it at all, and even the direct engine needs its `mapClaims` / `userInfoUrl` extension
point. (a) Drop it; document the `RawRoute` escape hatch. (b) Keep `customOauth2()` on the direct engine
only — free if OD-0 resolves to (b) or (c), since that engine already implements it.
**Recommendation: (b) if OD-0 is (b)/(c)** — it is existing, working code and GitHub sign-in is a common
ask; **(a) only if OD-0 is (a)**. Either way the maintainer should confirm whether any customer depends
on GitHub sign-in today.

**5. Ship a real store for reactivity?** (a) Land `submitAuthAction` (PR #208) as-is and stop.
(b) Additionally export `subscribeAuthState` + `getAuthStateSnapshot` so React can use
`useSyncExternalStore` (recommended) — the natural generalization of what #208 patches around, and
what the #185 investigation recommended. **Recommendation: (b), as a follow-up PR** so #208 is not
blocked.

**6. `userId` migration.** Unified `userId === username` changes semantics for `AuthOIDC`
(`` `${iss}:${sub}` ``) consumers, and `bb-data`'s generated CRUD and `test-apps/comprehensive`'s
`oidcProfiles` KVStore key on it. (a) Accept the break, document it (preview-stage service).
(b) Keep an `AuthOIDC`-compatible `userId` for federated users — permanently asymmetric ids within
one block. **Recommendation: (a)**, and steer everyone to `userSub` (the only stable id) in docs and
templates.

**7. Suppress `UsernameExistsException` on the public sign-up path?** (§6.3.4) (a) Yes — uniform
`confirmingSignUp` state, closing the last enumeration vector on the public surface; costs a worse
UX ("account exists" becomes invisible) and diverges from raw Cognito. (b) No — document it as a
known vector. (c) Make it an option, defaulting to safe. **Recommendation: (c)**, e.g.
`emailPassword: { revealExistingUsers?: boolean }` defaulting to `false`, so the safe behaviour is
the default and apps that want the friendlier message opt in.

**8. Rename the four `fetch*` methods?** (§G14) (a) Rename to `getAuthSession` / `getUserAttributes` /
`getMfaPreference` / `scanDevices` (recommended — G14 explicitly lists `fetch` as a verb to avoid,
and a unification is the only cheap moment to fix it). (b) Keep the `fetch*` names for Amplify-v6
familiarity and record a G14 exception in `API-DESIGN.md`. **Recommendation: (a)**, with the old names
kept as `@deprecated` aliases for one minor if that is acceptable.

**9. Pick the 401 error name** (§6.4): `NotAuthenticatedException` (recommended) vs.
`SessionExpiredException`. Either way `auth-common`'s `BlocksAuth` JSDoc is wrong today and one
existing e2e suite must change.

**10. Is dropping `getClient()` acceptable?** (§5.2) It is the only auth Transferable and
`test-apps/comprehensive`'s frontend uses it. **Recommendation: drop it** — it is replaceable by the
`url`-bearing actions plus `submitAuthAction`, and its current implementation is internally
inconsistent (descriptor wider than its type, hydrated object drops `toJSON()`, N discovery calls per
invocation). Needs maintainer sign-off as a breaking change.

**11. Scope of `validateUser` — is a Cognito trigger in scope?** It is the only genuinely *new*
capability proposed here, and it is rated the highest-value hook in better-auth
(`user.validateUserInfo`). Today only OIDC has `onSignIn`, and nothing can block a *sign-up*. On the
sign-in path the hook runs in-process and needs no new infrastructure. Blocking self-service sign-up
requires a **PreSignUp Lambda trigger** — and `bb-auth-cognito/DESIGN.md` currently lists Lambda
triggers as explicitly out of scope. (a) Ship `validateUser` for sign-in only, now; add the sign-up
trigger later. (b) Ship both, provisioning a PreSignUp trigger only when the option is present.
(c) Defer entirely. **Recommendation: (b)**, because a policy gate that silently does not apply to
sign-up is a security trap — but it does mean this block starts owning a trigger Lambda, which is a
scope expansion the maintainer should agree to explicitly.

**12. Do we still ship a zero-cost, zero-external-service auth option?** Replacing `bb-auth-basic` with
Cognito is a regression for its intended use case: `AuthBasic` is DynamoDB + bcrypt + a self-signed JWT
— **$0 per user**, no external service, arbitrary usernames, customer-supplied code delivery, fully
offline, no pool-deploy latency. On Cognito the same app gains MAU billing (10,000 free, then paid), a
~1–3 min pool deploy, Cognito's username/attribute schema, Cognito's fixed password-policy knobs, and
Cognito's 50-messages/day email limit without SES. **If the merged block has no zero-cost mode, the
cheapest option in the framework disappears** — and the scaffolding `default`, `react` and `demo`
templates all currently ship `AuthBasic`. (a) Accept the regression; document the 10,000-MAU free tier
as "effectively free for prototypes". (b) Keep `bb-auth-basic` alive as a deliberately minimal
prototyping block, and let the unified block be the production answer — but that re-creates a *choice*,
which is what this refactor is meant to remove. (c) Give the unified block a `local`/`self-hosted`
native engine (the AuthBasic implementation as a third engine under §7.0's structure), selected by
config rather than by package. **Recommendation: (a) for v1** — the 10,000-MAU free tier genuinely does
cover prototypes, and (c) is attractive but is a large amount of new surface for a case the free tier
already serves. Revisit if template users report cost or deploy-latency pain. **This should be an
explicit, recorded decision (a `docs/DECISIONS.md` entry), not a side effect of the merge.**
