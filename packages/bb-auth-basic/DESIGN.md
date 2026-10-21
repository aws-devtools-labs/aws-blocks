# AuthBasic — Design

Design document for AuthBasic. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-auth-basic`
**Re-exported from:** `@aws-blocks/blocks`
**Type:** Composite (composes KVStore and AppSetting — no dedicated infrastructure)
**AWS Service:** None directly — uses DynamoDB (via KVStore) and SSM Parameter Store (via AppSetting)

## Overview

AuthBasic provides simple username/password authentication built on KVStore and AppSetting. It handles sign-up, sign-in, JWT sessions, password policy enforcement, optional code-confirmed signup, and password reset. It implements the common `BlocksAuth` interface from `@aws-blocks/auth-common`.

**Key distinction from AuthOIDC/AuthCognito:** AuthBasic has no external identity provider. It is self-contained — users are stored in a KVStore, passwords are hashed with bcrypt, sessions are JWT cookies. Use for prototyping, internal tools, or apps that don't need OAuth/OIDC/MFA.

## Architecture

```
AuthBasic (extends Scope, implements BlocksAuth)
    ├── KVStore (users) — stores UserRecord { hash, createdAt, unconfirmed? }
    ├── KVStore (codes) — HMAC-hashed verification codes + expiry, `revoked:<jti>` sign-out markers, and `lockout:<username>` sign-in throttle counters
    ├── AppSetting (jwt-secret) — SSM SecureString for JWT signing key
    └── Logger (optional) — error-level by default

Session Flow:
    signIn(username, password, context)
        → bcrypt.compare(password, stored hash)
        → jwt.sign({ username }, secret, { expiresIn })
        → Set-Cookie: auth_{fullId}=<JWT>; HttpOnly; Secure; SameSite=Lax (crossDomain: true → SameSite=None; Partitioned)

    requireAuth(context) / getCurrentUser(context)
        → parse cookie from request headers
        → jwt.verify(token, secret, { algorithms: ['HS256'], issuer })
        → lookup UserRecord to confirm user still exists & is confirmed
        → return AuthBasicUser

Code Delivery Flow (when codeDelivery is configured):
    signUp → user stored with { unconfirmed: true } → code generated → codeDelivery(username, code)
    confirmSignUp → verifyCode → remove unconfirmed flag
    resetPassword → code generated → codeDelivery(username, code)
    confirmResetPassword → verifyCode → bcrypt.hash(newPassword) → update UserRecord

Browser Stub:
    └── AuthBasic class with no-op constructor, createApi(), buildApi()
        (actual implementation runs server-side only)
```

## State Machine Behavior

`createApi()` exposes the auth state machine that drives the `<Authenticator>` component via `getAuthState` / `setAuthState` (see the README for signatures). `buildApi()` is a deprecated predecessor retained for backward compatibility — use `createApi()` instead. The design-relevant behavior is below.

### Auth States Produced by AuthBasic

| State | When | Actions Available |
|-------|------|-------------------|
| `signedOut` | No valid session | `signIn`, `signUp`, `resetPassword` (if codeDelivery configured) |
| `signedIn` | Valid JWT session | `signOut` |
| `confirmingSignUp` | After signUp with codeDelivery | `confirmSignUp` |
| `confirmingPasswordReset` | After resetPassword | `confirmResetPassword` |

### Auto-Sign-In Behavior

The state machine automatically signs the user in (establishing a session cookie) in two scenarios:

1. **signUp without `codeDelivery`:** After successful registration, `signIn()` is called immediately with the same credentials, transitioning directly to `signedIn` state. The user never sees the `signedOut` state after registration.
2. **confirmSignUp:** After successful code verification, `signIn()` is called with the provided `username` and `password`, transitioning directly to `signedIn` state. This is why the `confirmSignUp` action requires the `password` field (see D-AB-9).

### Error Recovery in `setAuthState`

The `setAuthState` method never throws. If any action fails, the error is caught and the method returns the current valid auth state with an `error` field attached:

1. The current session cookie is checked to determine whether the user is signed in or out.
2. The appropriate base state (`signedIn` or `signedOut`) is constructed.
3. The error message is merged: `{ ...baseState, error: e.message }`.

This allows the Authenticator UI component to display errors without losing track of the current state machine position. Unknown actions return `{ ...signedOutState, error: "Unknown action: ..." }` without throwing.

## Design Decisions

### D-AB-1: Composite Building Block (no dedicated infrastructure)

**Decision:** AuthBasic composes KVStore and AppSetting rather than creating its own DynamoDB tables or Lambda functions. No separate CDK or AWS runtime entry points exist.

**Rationale:**
- **Simplicity** — no CDK construct to maintain, no IAM policies to manage. All infrastructure is inherited from composed BBs.
- **Context switching** — KVStore and AppSetting handle mock/AWS/CDK context switching automatically. AuthBasic code is environment-agnostic.
- **Reuse** — the same KVStore infrastructure (DynamoDB PAY_PER_REQUEST) that other BBs use is leveraged for user and code storage.
- **Trade-off** — cannot independently configure table capacity or TTL; acceptable for the auth-basic use case.

### D-AB-2: JWT sessions signed with AppSetting secret

**Decision:** Session tokens are JWTs signed with HS256 using a secret stored in AppSetting (SSM SecureString in AWS, in-memory in mock). The secret is lazily fetched and cached per instance.

**Rationale:**
- **Mostly stateless validation** — a JWT is verified from the signing secret alone, with one small exception: sign-out revocation (below) adds a single KVStore read per authenticated request to check the token's `jti` against the revocation list. Tokens with no `jti` (issued before revocation shipped) skip that read and simply expire within `sessionDuration`.
- **Shared secret** — AppSetting ensures all Lambda instances use the same signing key, so tokens are valid across cold starts.
- **Security** — secret is stored in SSM SecureString (encrypted at rest); never exposed in code or environment variables.
- **Revocable on sign-out** — `signOut` records the presented token's `jti` on a revocation list (the `codes` store, keyed `revoked:<jti>`), with an expiry equal to the token's own `exp` so the list self-trims. `getUserFromCookie` rejects a revoked `jti`, so a copied or replayed cookie no longer authenticates after sign-out. This trades pure in-memory validation for one KVStore read per request. `requireAuth` reports a revoked session as `SessionRevokedException` and an absent/aged-out one as `SessionExpiredException`, so a client can message "you signed out / your session was revoked" differently from "your token expired"; the session is resolved in a single pass that carries the reason, so classifying the failure costs no extra verify or read. The revocation-list read is an eventually-consistent DynamoDB `GetItem` (no `ConsistentRead`, the same as every other KVStore read), so revocation is near-immediate rather than instantaneous: immediately after `signOut` writes the marker, a token replayed against a different Lambda instance may still authenticate for the sub-second propagation window before the write is visible everywhere. For richer session management (refresh tokens, device management), use AuthCognito.

### D-AB-3: bcrypt for password hashing (cost factor 12)

**Decision:** Passwords are hashed with bcrypt at cost factor 12 (4,096 rounds) using the `bcryptjs` library.

**Rationale:**
- **OWASP compliance** — cost factor 12 is the recommended minimum as of 2024 OWASP guidelines.
- **Pure JavaScript** — `bcryptjs` has no native dependencies, ensuring portability across Lambda runtimes and local dev.
- **Adaptive** — the cost factor can be increased in future versions without breaking existing hashes (bcrypt stores the cost in the hash prefix).
- **Trade-off** — hashing takes ~250ms at cost 12. Acceptable for auth operations (not called in hot paths).

### D-AB-4: HMAC-hashed verification codes (never stored in plain text)

**Decision:** Verification codes (signup and password reset) are 6-digit numeric strings. Before storage, the code is HMAC-SHA256 hashed with the JWT secret and a purpose+username prefix. Only the HMAC is stored.

**Rationale:**
- **Security** — if the KVStore is compromised, codes cannot be extracted. The attacker would need both the stored HMAC and the JWT secret.
- **Constant-time comparison** — `constantTimeEquals` from `@aws-blocks/core/bb-utils` prevents timing attacks during verification.
- **10-minute TTL** — codes expire after 600 seconds, limiting the attack window.
- **Non-enumerable** — 6-digit codes have 900,000 possible values. Combined with TTL, brute-force is impractical.

### D-AB-5: Cookie attributes (HttpOnly; SameSite=Lax default, cross-domain opt-in)

**Decision:** Session cookies default to `HttpOnly; SameSite=Lax; Path=/`, with `Secure` added in production (plain `SameSite=Lax` on localhost, where `Lax` does not require `Secure`). When `crossDomain: true`, the BB switches to `SameSite=None; Secure; Partitioned`. See [D-007](../../docs/DECISIONS.md#d-007-auth-cookies-default-to-samesitelax-cross-domain-is-opt-in) for the full rationale.

**Rationale:**
- **HttpOnly** — prevents JavaScript access, mitigating XSS token theft.
- **Secure** — only sent over HTTPS; enforced in production and dropped on plain-HTTP localhost (`SameSite=Lax` does not require it).
- **SameSite=Lax (default)** — withheld from cross-site subrequests (shrinking CSRF surface) but sent on same-site requests, including same-site cross-port dev. Correct now that dev and standard production deploys are same-origin.
- **SameSite=None; Secure; Partitioned (`crossDomain: true`)** — only for genuinely cross-domain deployments (frontend and API on a different registrable domain); `Partitioned` adds CHIPS isolation and is dropped on localhost (requires HTTPS).
- **Path=/** — cookie is sent with all requests to the API origin.
- **Max-Age** — set to `sessionDuration` (default 24h), providing natural expiration.

### D-AB-6: codeDelivery as an opt-in callback (not a composed BB)

**Decision:** Code delivery (for confirmed signup and password reset) is provided as a user-supplied callback function, not a composed Email or SMS Building Block.

**Rationale:**
- **Flexibility** — customers choose their own delivery mechanism (email, SMS, push notification, or logging for dev).
- **No vendor lock-in** — AuthBasic doesn't depend on a specific email service.
- **Graceful degradation** — when `codeDelivery` is not provided, signup is immediate and password reset is unavailable. The state machine adapts dynamically (the "resetPassword" action is only present when codeDelivery is configured).
- **Simplicity** — avoids a dependency on an Email BB that may not be available or configured.

### D-AB-7: Silent success for resetPassword on non-existent users

**Decision:** `resetPassword()` silently succeeds (no error) when the username doesn't exist.

**Rationale:**
- **User enumeration prevention** — an attacker cannot discover valid usernames by observing different error responses for existing vs. non-existing users.
- **Standard practice** — this is the recommended pattern for password reset flows (OWASP, NIST).

### D-AB-8: Single-file implementation (no separate CDK/AWS/mock entry points)

**Decision:** The entire implementation lives in `src/index.ts` with a browser stub in `src/index.browser.ts`. There are no separate `index.cdk.ts`, `index.aws.ts`, or `index.mock.ts` files.

**Rationale:**
- **Composite BB** — because AuthBasic composes KVStore and AppSetting (which handle their own context switching), there is no need for separate environment-specific entry points.
- **Two conditional exports only** — the package exposes just `default` (full server implementation) and `browser` (a stub of types, error constants, and a no-op `createApi()`/`buildApi()` class) export conditions. There is no `cdk`, `aws-runtime`, or `hooks` export because the composed KVStore and AppSetting own all infrastructure and runtime concerns.
- **Code simplicity** — one file contains all logic. The same code runs in mock (KVStore mock = JSON files) and AWS (KVStore AWS = DynamoDB).
- **Trade-off** — if AuthBasic later needs environment-specific behavior (e.g., rate limiting in AWS only), it would need to be split. Acceptable for current scope.

### D-AB-9: createApi() requires password for confirmSignUp

**Decision:** In the `createApi()` state machine, the `confirmSignUp` action requires `password` in addition to `username` and `code`. After confirmation, the user is automatically signed in.

**Rationale:**
- **UX** — users don't have to sign in separately after confirming their account. One step instead of two.
- **Implementation** — AuthBasic needs the password to call `signIn()` and establish a session. Unlike Cognito (which has server-side session continuity), AuthBasic has no way to auto-authenticate without the password.
- **Trade-off** — diverges from the auth-common interface where `password` is optional for `confirmSignUp`. The Authenticator component must render the password field in the confirmation form when using AuthBasic.

### D-AB-10: Named error constants only for user-facing input errors

**Decision:** User-input and session failures a caller may recover from (`InvalidCredentials`, `UserAlreadyExists`, `InvalidCode`, `SessionExpired`, `SessionRevoked`, `SignOutIncomplete`, `InvalidPassword`, `AccountLocked`) get named constants in `AuthBasicErrors`; configuration errors — such as calling `resetPassword` when `codeDelivery` was never configured — are thrown as a plain `ApiError` with no named constant.

**Rationale:** A named constant exists so callers can branch on it via `isBlocksError(e, AuthBasicErrors.X)`. That is worthwhile for user-input errors a caller may recover from, but not for a configuration mistake (using a feature that was not enabled), which is a build-time programming error to fix rather than a runtime condition to branch on.

### D-AB-11: Opt-in per-username sign-in throttling (application-layer lockout)

**Decision:** AuthBasic can lock an account after `maxAttempts` consecutive failed sign-ins, via the optional `lockout` policy (`maxAttempts`/`windowSeconds`/`lockoutSeconds`, defaults 5 / 900 / 900). Counting is **per-username**, stored in the shared `codes` store under `lockout:<username>` as `{ count, firstFailAt, lockedAt? }` with a TTL of the longer of the two windows. `lockedAt` is stamped when the count first reaches `maxAttempts` and is what the lockout window is measured from. The lock is enforced at the **top of `signIn`**, before the user record is read or the password compared. The policy is validated at construction (dev time) — a non-positive-integer `maxAttempts` or non-positive window throws. Throttling is **disabled unless `lockout` is passed** — default behavior is unchanged.

**Rationale:**
- **Credential-stuffing/brute-force parity with `AuthCognito`.** Cognito provides managed sign-in lockout; this closes the gap for AuthBasic (issue #766) so the two auth BBs offer comparable protection against password guessing.
- **Per-username, not per-IP.** The username is the credential-stuffing target. IP-based counting risks locking out a whole shared NAT/corporate egress on one user's typos, and `BlocksContext` client-IP extraction is proxy-dependent. Cognito's own lockout is per-user; this matches it.
- **Check before bcrypt.** Enforcing the lock before the `bcrypt.compare` sheds the (deliberately expensive) hash cost under an attack, and makes the lock decision independent of whether the password was right — no password-dependent timing signal.
- **Lock window anchored at the trip, not the first failure.** Expiry is measured from `lockedAt` (the moment the count reached `maxAttempts`), not from the oldest failure. Anchoring on the first failure would let failures spaced across the counting window trip a lock that expires almost immediately — pathologically, when `windowSeconds == lockoutSeconds` (the default), the lock could be already-expired at the instant it tripped.
- **Best-effort counter (eventually counted), not atomic.** `recordFailedSignIn` is a read-modify-write with no conditional/atomic guard (the KVStore exposes no atomic ADD). Highly concurrent failures for the same username — inherent to credential stuffing, and across many Lambda instances against shared DynamoDB — can interleave and lose an increment, so the lock may trip slightly later than `maxAttempts` implies. This is a bounded weakening (the window/lockout bounds cap the blast radius), never a safety hole, and is an accepted trade-off against the cost/complexity of a conditional-write retry loop on the hot sign-in path.
- **Self-expiring, bounded storage.** Counters live in the same TTL-backed `codes` store as verification codes and revocation markers, so they self-reap and never grow unbounded. A failed throttle write is logged, never thrown — throttle bookkeeping must not turn a failed sign-in into a 5xx.
- **429 `AccountLockedException`, generic message.** The error is branded (crosses the wire by name) with a generic message that reveals neither the username nor any SDK metadata. `retriable` is left `false` (a lockout requires waiting out the window, not an immediate retry — consistent with core's own "too-many-attempts lockouts" guidance).

**Not** a replacement for infrastructure-layer rate limiting (CloudFront WAF, API Gateway throttling), which still belongs in front of the API for volumetric/DDoS protection. This is per-account credential-guess protection, complementary to the network layer.

## Infrastructure (CDK)

None directly — AuthBasic is a composite Building Block with no CDK construct. All infrastructure is created by composed Building Blocks:

| Composed BB | Creates | Purpose |
|-------------|---------|---------|
| `KVStore(this, 'users')` | DynamoDB table (PAY_PER_REQUEST) | User records: username → `{ hash, createdAt, unconfirmed? }` |
| `KVStore(this, 'codes')` | DynamoDB table (PAY_PER_REQUEST) | Verification codes: `purpose:username` → `{ hmac, expires }` |
| `AppSetting(this, 'jwt-secret')` | SSM Parameter (SecureString) | JWT signing secret |

All permissions (DynamoDB read/write, SSM GetParameter) are managed by the composed BBs via the standard Blocks grant mechanism. No additional IAM configuration is needed.

**Removal policy:** Inherited from composed BBs (DESTROY in sandbox mode).

## AWS Runtime

AuthBasic has no separate AWS runtime entry point. The same `src/index.ts` code runs in both mock and AWS environments. Context switching is handled by the composed Building Blocks:

- **KVStore** — uses DynamoDB in AWS, JSON files (or in-memory) in mock.
- **AppSetting** — uses SSM Parameter Store in AWS, in-memory value in mock.

When running in AWS Lambda:
- JWT secret is fetched from SSM SecureString on first use, then cached in-memory for the Lambda instance lifetime.
- User records and verification codes are stored in DynamoDB tables created by KVStore CDK constructs.
- bcrypt hashing runs in the Lambda Node.js runtime (~250ms per hash at cost 12).
- JWT verification is sub-millisecond (HS256 symmetric).

## Mock Implementation

The mock behavior is identical to AWS behavior with the following environment differences:

- **KVStore mock** — stores data in-memory (or JSON files on disk, depending on KVStore mock mode). Data is lost on restart.
- **AppSetting mock** — generates a random secret on first access within the process. Secret changes on restart (invalidating existing tokens).
- **bcrypt** — runs identically (pure JS implementation, same cost factor 12).
- **JWT** — same `jsonwebtoken` library, same HS256 algorithm.
- **Code delivery** — calls the user-provided `codeDelivery` callback. In dev, this is typically `console.log` or a custom function.

### Internal Storage Formats

**User records** (stored as JSON string in KVStore):
```json
{
  "hash": "$2a$12$...",      // bcrypt hash of password
  "createdAt": "2024-...",   // ISO 8601
  "unconfirmed": true        // only present when codeDelivery is configured and signup not confirmed
}
```

**Verification codes** (stored as JSON string in KVStore, keyed by `purpose:username`):
```json
{
  "hmac": "a1b2c3...",       // HMAC-SHA256 of "purpose:username:code" with JWT secret
  "expires": 1700000000000   // Unix timestamp (ms) when code expires (10 min TTL)
}
```

**Legacy user record handling:** If a raw value is stored (starts with a non-`{` character), it's treated as a bare bcrypt hash with epoch creation date. This supports migration from an earlier format.

## Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| Secret regenerated on restart (mock) | Existing JWTs are invalidated when the dev server restarts | Intentional for local dev — sign in again after restart |
| No DynamoDB TTL reaper (mock) | Expired codes, revocation markers, and throttle counters remain in the in-memory store until read | Verification codes, `revoked:<jti>` markers, and `lockout:<username>` counters are all written with a TTL (`expiresAt`/`ttlSeconds`), so the AWS `codes` store (created with `ttl: true`) physically reaps them; reads filter expired entries on both layers regardless, so correctness never depends on the reaper |
| Sign-in throttling is per-process (mock) | A lockout counter lives in the per-process in-memory store, so a multi-instance mock wouldn't share it | When `lockout` is enabled, counters live in the shared `codes` DynamoDB table, so the lock is enforced across every Lambda instance. When `lockout` is **not** set there is no application-layer limit at all — rely on CloudFront WAF or API Gateway throttling for volumetric protection |
| No cross-instance session invalidation | Signing out on one mock instance doesn't affect others | In AWS the revocation list lives in the shared `codes` DynamoDB table, so sign-out revokes the token for every instance; the mock's in-memory store is per-process, so a multi-instance mock would not share it (not applicable in single-instance local dev) |
| bcrypt timing may differ | Hashing speed varies between local machine and Lambda | No mitigation needed — timing differences don't affect correctness |
| No email/SMS delivery infrastructure | Codes are delivered via callback (typically console.log in dev) | Intentional — codeDelivery is the integration point for real delivery in production |

## Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Composite BB (no own infrastructure) | Cannot tune storage independently, but avoids CDK complexity |
| JWT sessions, revocable on sign-out | One KVStore read per authenticated request (to check the revocation list), rather than pure in-memory JWT validation |
| bcrypt cost 12 | ~250ms per hash, but meets OWASP minimum |
| Single-file implementation | Cannot have env-specific behavior, but keeps code simple |
| codeDelivery as callback | No built-in email/SMS, but maximum flexibility |
| HMAC-hashed codes | Cannot recover codes if secret is lost, but prevents code theft from storage |
| SameSite=None cookies (crossDomain: true) | Required for cross-domain, but less restrictive than the Lax default |
| Password required for confirmSignUp | Extra field in confirmation form, but enables auto-sign-in after confirmation |
| No `fromExisting()` | Cannot wrap pre-existing user tables, but keeps ownership model clean |

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| Password storage | bcrypt with cost 12 (OWASP recommended minimum) |
| Token theft (XSS) | HttpOnly cookies — not accessible via JavaScript |
| Token theft (network) | Secure flag — only sent over HTTPS |
| Token replay after sign-out | Revocation list keyed by `jti` — `signOut` records the token id (self-expiring at the token's `exp`), and every auth check rejects a revoked `jti`, so a copied/replayed cookie stops working at sign-out rather than at `exp` |
| Timing attacks on code verification | `constantTimeEquals` for HMAC comparison |
| User enumeration (resetPassword) | Silent success for non-existent users |
| Code brute-force | 10-minute TTL + 900,000 possible values |
| Secret exposure | Stored in SSM SecureString (encrypted at rest) |
| Cross-site request forgery | SameSite=Lax by default (CSRF-resistant); SameSite=None + Partitioned when crossDomain: true (CHIPS isolation) |
| Unconfirmed user access | signIn rejects users with `unconfirmed: true` |

## Integration with Auth-Common

AuthBasic implements the `BlocksAuth` interface from `@aws-blocks/auth-common`:

| BlocksAuth Method | AuthBasic Implementation |
|----------------|--------------------------|
| `requireAuth(context)` | Parse cookie → verify JWT → lookup user → return `AuthBasicUser` or throw 401 |
| `checkAuth(context)` | Same as above, returns `boolean` instead of throwing |
| `getCurrentUser(context)` | Same as above, returns `null` instead of throwing |

The `createApi()` method produces the state machine API consumed by the Authenticator component from `@aws-blocks/auth-common/ui`. The state machine adapts dynamically based on configuration:
- Without `codeDelivery`: `signedOut` ↔ `signedIn` (immediate signup, no password reset)
- With `codeDelivery`: full flow including `confirmingSignUp` and `confirmingPasswordReset` states

## Comparison with Other Auth BBs

| Aspect | AuthBasic | AuthOIDC | AuthCognito |
|--------|-----------|----------|-------------|
| **User storage** | KVStore (DynamoDB) | External provider | Cognito User Pool |
| **Password management** | bcrypt (self-managed) | N/A (provider handles) | Cognito (SRP protocol) |
| **Session mechanism** | Self-signed JWT cookie | Self-signed JWT cookie | Cognito tokens + cookie |
| **MFA** | ❌ | ❌ | ✅ |
| **Social sign-in** | ❌ | ✅ | ✅ (federation) |
| **Password reset** | ✅ (with codeDelivery) | ❌ | ✅ (built-in) |
| **User groups/roles** | ❌ | ❌ | ✅ |
| **Infrastructure** | Composite (KVStore) | Lambda + RawRoute | Cognito User Pool + Client |
| **Best for** | Prototyping, internal tools | Social login apps | Enterprise apps |
