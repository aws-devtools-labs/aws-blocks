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
    ├── KVStore (codes) — stores HMAC-hashed verification codes + expiry
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
- **Stateless validation** — JWT tokens can be validated without a database round-trip (only need the secret, not a session table lookup).
- **Shared secret** — AppSetting ensures all Lambda instances use the same signing key, so tokens are valid across cold starts.
- **Security** — secret is stored in SSM SecureString (encrypted at rest); never exposed in code or environment variables.
- **Trade-off** — cannot revoke individual sessions (JWT is valid until expiry). Acceptable for basic auth; if token revocation is needed, use AuthCognito.

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

**Decision:** User-input failures (`InvalidCredentials`, `UserAlreadyExists`, `InvalidCode`, `SessionExpired`, `InvalidPassword`) get named constants in `AuthBasicErrors`; configuration errors — such as calling `resetPassword` when `codeDelivery` was never configured — are thrown as a plain `ApiError` with no named constant.

**Rationale:** A named constant exists so callers can branch on it via `isBlocksError(e, AuthBasicErrors.X)`. That is worthwhile for user-input errors a caller may recover from, but not for a configuration mistake (using a feature that was not enabled), which is a build-time programming error to fix rather than a runtime condition to branch on.

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
| No DynamoDB TTL on codes (mock) | Expired codes remain in storage until explicitly checked | Code expiry is checked at verification time; stale entries are deleted on access |
| No rate limiting on sign-in attempts | Brute-force attacks succeed locally | No mitigation — acceptable for local dev. Production should use CloudFront WAF or API Gateway throttling at the infrastructure level |
| No cross-instance session invalidation | Signing out on one mock instance doesn't affect others | Not applicable in local dev (single instance). In AWS, JWT-based sessions are stateless — signOut only clears the client cookie |
| bcrypt timing may differ | Hashing speed varies between local machine and Lambda | No mitigation needed — timing differences don't affect correctness |
| No email/SMS delivery infrastructure | Codes are delivered via callback (typically console.log in dev) | Intentional — codeDelivery is the integration point for real delivery in production |

## Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Composite BB (no own infrastructure) | Cannot tune storage independently, but avoids CDK complexity |
| JWT sessions (stateless) | Cannot revoke individual sessions, but avoids session store lookups |
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
