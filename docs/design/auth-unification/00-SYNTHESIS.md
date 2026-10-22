# Auth unification — synthesis & decision log

> **Status:** planning complete, awaiting maintainer decisions. No source code changed.
> **Branch:** `refactor/auth-blocks`. **Goal:** collapse `bb-auth-basic`, `bb-auth-cognito`, `bb-auth-oidc` (+ `auth-common`) into one auth Building Block, Cognito-backed, with OIDC configurable through the same block. Inspiration: [better-auth](https://better-auth.com/docs/authentication).
> **Problem being solved:** users cannot tell which of the three blocks to pick, or why.

## Reports

| # | Report | What it establishes |
|---|---|---|
| 1 | [01-inventory.md](01-inventory.md) | Full API surface of all three BBs + `auth-common`, overlap/divergence matrix, every downstream consumer, branch status |
| 2 | [02-better-auth-prior-art.md](02-better-auth-prior-art.md) | better-auth / Auth.js / Clerk / Amplify `defineAuth` patterns; what to adopt, consolidate, reject |
| 3 | [03-cognito-capabilities.md](03-cognito-capabilities.md) | What Cognito can and cannot do, URL-cited; cost cliffs; immutable properties; mock-fidelity grades |
| 4 | [04-unified-api-design.md](04-unified-api-design.md) | The proposed `Auth` config object + method surface, layer sketch, error taxonomy, G1–G18 self-review |
| 5 | [05-migration-and-phasing.md](05-migration-and-phasing.md) | Breaking-change surface, deprecation strategy, phased PR plan, test strategy, 14-entry risk register |

## The one-paragraph answer

Unify **config, client UI, and session/identity**; split **server methods** honestly. Federated sign-in physically cannot go through the SDK — AWS: federated users "can only sign in with the Login endpoint or the Authorize endpoint" — so one uniform method surface across native and federated auth is not achievable at any layer. The existing code already proves this: `bb-auth-oidc` implements **1 of 14** state-machine actions and bolts on a `getClient()` method that breaks the shared `AuthStateApi` shape. The fix for "which block do I pick" is a single **config object**, not a single method list.

## What we already have (the reframe)

The refactor is closer to *promotion and consolidation* than to invention. `bb-auth-oidc` already implements several of better-auth's best ideas — a `kind`-discriminated provider union with named factories (`google()`, `customOidc()`, `cognitoFederated()`, `stubIdp()`), `SecretLike` thunks, and `ProviderName<P>` / `AuthCognito<const O>` type-flow that **closes the server→client typing gap better-auth, Auth.js, Clerk and Amplify all leave open**. They are invisible today: every one is `ae-forgotten-export`, and `packages/blocks` re-exports ~30 Cognito types vs 4 OIDC ones. That asymmetry is itself a cause of the confusion.

`BlocksAuth` (`packages/auth-common/src/index.ts:40-66`) is the correct shared contract and should be extended, not replaced — two independent unmerged efforts (`feat/bb-auth-jwt`, `supabase-auth-poc`) each re-derived the same shape. `requireRole` is its missing member.

## Proposed shape

```ts
new Auth(scope, 'auth');                                  // email+password, one line
new Auth(scope, 'auth', { oidcProviders: { okta: { issuer, clientId, clientSecret: oktaSecret } } });
new Auth(scope, 'auth', { emailPassword: false, oidcProviders: { … } });   // OIDC-only
new Auth(scope, 'auth', { socialProviders: { google: { clientId, clientSecret: gSecret } } });
```

Three keyed records (`oidcProviders` / `socialProviders` / `samlProviders`), not one record and not an array: the record key *is* the provider id on both server and client (avoiding Amplify's `externalProviders.google` → `signInWithRedirect({provider:'Google'})` mismatch), and the split makes the 200× pricing cliff visible at the call site. Secrets are `AppSettingRef`, never strings.

Client UI unifies via a form model: an `AuthAction` carries either `fields` (RPC) or a `url` (browser form submit). Zero client branching, RPC surface stays two methods, `getClient()` goes away. The native/federation method split is enforced as a **compile error** using the rest-tuple parameter gate the repo already ships for `auth.admin`.

## Decisions needed from maintainers

Ordered by how much downstream work they gate.

### D0 — Does generic OIDC federate *through* Cognito, or run beside it?
Central decision; everything else is downstream.

- **Recommended: (c) both engines, per-provider `federateVia`, default `'direct'` for `oidcProviders`; social + SAML always via Cognito.**
- Why: (b) isn't actually simpler — SAML has no direct implementation and social is *cheap* through Cognito, so both engines ship either way. Per-provider selection also fixes a live bug where one `cognitoFederated()` entry silently disables co-declared providers.
- Evidence against routing generic OIDC through Cognito: **200× cost** (50 free MAU vs 10,000 for direct *and* social); **no PKCE toward the IdP**, client secret mandatory, `client_secret_basic` unsupported → PKCE-only IdPs cannot federate at all; **federation is unmockable locally** (grade F; today's mock throws `cognitoUnavailableLocally()`), forfeiting offline iteration — the one differentiator no competitor in the prior art has.
- Cost of (c): direct-federated users get no Cognito pool groups. Mitigated by `groupsClaim`.
- **If the "solely Cognito" line is held anyway, a mock hosted-UI shim becomes mandatory, not optional.**

### D1 — Unify the error vocabulary (breaking; AGENTS.md rule 6)
`requireAuth` throws `SessionExpiredException` (Basic `index.ts:395`) vs `NotAuthenticatedException` (Cognito `index.ts:1167`, OIDC `auth-oidc.ts:648`), and `auth-common/src/index.ts:47` documents only the first. Also `UserAlreadyExistsException` vs `UsernameExistsException`, `requireSpecialChars` vs `requireSymbols`, `codeDelivery` 2-arg vs 3-arg. Recommendation: standardize on `NotAuthenticatedException`.

### D2 — Do we drop `bb-auth-basic`?
Replacing it with Cognito removes the framework's **only zero-cost, fully-offline auth option**. Recommendation: accept for v1, record it in `DECISIONS.md`. Migrating existing Basic users requires a Cognito `UserMigration` Lambda trigger (own phase) — a codemod cannot move bcrypt hashes into Cognito.

### D3 — Cookie collision cutover
`bb-auth-basic` and `bb-auth-cognito` share the cookie name `auth_${fullId}` with **incompatible payloads**, so a cutover hands an already-signed-in user a garbage cookie. Choose: reject-and-clear (forced re-login) vs recognize-and-upgrade.

### D4 — PR #583 contradicts documented design
#583 makes `requireRole` read live groups; `bb-auth-cognito/DESIGN.md` Key Design Decision #3 states claim-based groups are deliberate. One of them is wrong. This is a semantics call, not a rebase.

### D5 — Accept the `userId` break?
Four `User` types disagree; `userId` variously means username, `sub`, or `${iss}:${sub}`. Recommendation: accept the break, steer users to `userSub`.

Smaller ones with recommendations in report 4 (§open decisions): package name `@aws-blocks/bb-auth`, keep `auth-common`, keep `customOauth2`, export a real store for React, option-gate `signUp` enumeration, rename four `fetch*` methods per G14, drop `getClient()`, and whether `validateUser` justifies a PreSignUp trigger.

## Prerequisites — these are blockers, not cleanup

CI cannot currently catch the regressions the later phases risk:

1. Root `tsconfig.json:3-19` reaches `bb-auth-cognito` and `bb-auth-oidc` only transitively, and `*.types-test.ts` is checked *only* by `tsc` → 4 Cognito type-contract files likely unexercised.
2. `conditional-exports.test.ts` never discovers `auth-common` (no `bb-` prefix) and checks only one direction — never `cdk`/`browser` per BB. Real parity gaps pass green.
3. `bb-auth-cognito/src/index.aws.ts` is 2,465 lines with **6** default-run tests; the rest are `BLOCKS_INTEGRATION=1`-gated and skipped by `npm test`. The base-class refactor moves all 2,465 lines.

## Deployment safety (verified, corrected)

Renaming `AuthCognito` → `Auth` is **resource-identity-neutral**: the CDK `Scope` ctor does `super(parent, id)` (`core/src/cdk/index.ts:231-237`) and `computeScopeFullId` joins **ids only** (`core/src/common/index.ts:314-324`) — the class name is in neither the construct path nor `fullId`. No `UserPool` property triggers CFN replacement; pools are effectively permanent.

Two live hazards:

- **Catastrophic, uncaught by CI:** changing a *child construct id* (`pool`, `client`, `sessions`, `session-secret`, `group-<name>`), adding a nesting level, or changing the customer's block `id` makes CFN provision a new pool and **delete the old one** — `removalPolicy` defaults to `DESTROY` (`index.cdk.ts:229-231`). The sessions DynamoDB table and SSM session secret *are* replace-on-change → lost sessions + rotated HMAC = mass logout.
- **Everyday failure is rollback, not replacement:** four properties are immutable at the *service* level while CFN reports "No interruption" (sign-in/alias attributes, `CaseSensitive`, required attributes, existing custom attributes). CDK synths, `UpdateUserPool` rejects, stack rolls back. **`cdk diff` is blind to this** → synth-time guards, and the upgrade-in-place test must assert `UPDATE_COMPLETE`, not just a clean diff.

## Deprecation (hybrid, not one strategy)

| Package | Strategy | Why |
|---|---|---|
| `bb-auth-cognito` | thin re-export shim | synth is byte-identical |
| `bb-auth-basic` | frozen but functional | aliasing onto Cognito re-provisions every deployment and orphans the bcrypt `<fullId>-users` table |
| `bb-auth-oidc` | frozen but functional | same re-provisioning hazard |
| `auth-common` | kept | shared contract lives here |

At 0.x a **minor** is already a hard wall for `^` consumers and `changeset-guard` forbids majors → a two-minor window suffices.

## Phase plan

P1a resource-identity golden test · **P1b close CI blind spots** → P2 land live branches → P3 canonical errors → P4a–d new `bb-auth` → P5a Basic `UserMigration` trigger, P5b (contingent on D0) → P6 deprecate → P7a–d consumers → P8 removal (out of scope). Sandbox e2e required at P2a, P4c, P5a, P5b, P6a, P7a.

## Branch reconciliation

**Live (3):** #208 (`submitAuthAction` — land before P4, worst rebase), #297 (`feat/bb-auth-jwt`, draft — decide before P4a), #583 (see D4). Plus #575 (db-pull string-emitted `AuthOIDC`) and #588 (native Kotlin OIDC — contingent on D0).

**Dead (5):** `fix/authenticator-test-ids` merged as #272; `fix/cognito-prevent-user-enumeration`, `fix/oidc-signin-shared-state`, `fix/bb-auth-oidc-stub-idp-reserved-params` already on main; `supabase-auth-poc` is a no-PR spike → abandon.

## Defects found along the way (fix regardless of this refactor)

- `bb-auth-oidc/README.md:366-369` claims Cognito federation adds **MFA on social sign-in**. AWS: for federated users Cognito "delegates all authentication processes to the IdP and doesn't offer them additional authentication factors." No MFA, no device tracking, no adaptive auth. This is the primary stated reason to choose the expensive path, and it is false.
- `bb-auth-basic` reads cookies with an **unanchored, unescaped regex** — a bug Cognito's `cookies.ts` already fixed. Do not carry it forward.
- Federated `signOut()` must also hit `/logout` or the managed-login cookie **silently re-authenticates** — a live security bug.
- Cognito **defaults new pools to the paid Essentials tier**; omitting `UserPoolTier` silently bills customers.
- Neither Cognito nor OIDC uses `synthGuard` — synth-time misuse throws a raw `TypeError`.
- `docs/reference/ARCHITECTURE-LAYERS.md` and `docs/reference/building-block-structure.md` are **stale** (they document `infra.ts`/`materialize()`) and will mislead the implementer.
- `bb-auth-oidc/API.md` is broken (6 `ae-forgotten-export` warnings, class surface absent).

## Compiler-invisible blast radius

Three native SDKs (Kotlin/Swift/Dart) hand-implement OIDC's HTTP protocol with no typecheck against the TS source; `bb-data/src/db-pull/templates.ts:181-215` emits `AuthOIDC` imports **as strings**; `test-apps/amplify-gen2` + `templates/amplify` carry a shadow `requireAuth` that never imports the interface.
