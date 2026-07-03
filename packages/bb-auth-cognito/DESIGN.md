# AuthCognito — Design

Design document. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-auth-cognito`
**Type:** Client-facing Building Block (provisions infrastructure, exposes a state-machine API)
**AWS Service:** Amazon Cognito User Pool + nested `@aws-blocks/bb-kv-store` for server-side sessions
**Auth flows:** `USER_PASSWORD_AUTH` (default) and `USER_AUTH` (choice-based, passwordless-capable). `AuthFlowType` typing exposes the full Cognito union (`USER_SRP_AUTH`, `CUSTOM_AUTH`) for forward compatibility, but unsupported values throw at construction time — both in the CDK construct and in the AWS runtime (defense-in-depth against `fromExisting` bypass). WebAuthn, SRP, and CUSTOM_AUTH are not supported.

## Scope

**In:**

- Username/password sign-in + sign-up with verification-code confirmation.
- MFA (SMS, TOTP, Email OTP) — selection, setup, and challenge continuation.
- User-pool groups wired to `requireRole(context, group)` for RBAC.
- Custom user attributes (`custom:*`) with `userAttributes` declaration.
- Device tracking (list, forget).
- Password reset via verification code.
- Provider-agnostic state machine driving the same `<Authenticator>` UI as every other Blocks auth BB.
- **Admin user-lifecycle + group-membership APIs** (`createUser`, `deleteUser`, `addUserToGroup`, `listUsersInGroup`, etc.) — exposed as an **opt-in `auth.admin` handle** on this class, gated by the `admin` options object. Off by default (no handle, no `Admin*` IAM). See *Admin surface* below and [BB-auth-cognito-admin-implementation-plan.md](../../docs/tech-design/BB-auth-cognito-admin-implementation-plan.md) for the rationale.

**Out (for this BB):**

- **HostedUI + federated sign-in** (Google / Facebook / LoginWithAmazon / Apple / OIDC / SAML) — not supported.
- **Cognito Lambda triggers** (`preSignUp`, `postConfirmation`, `preAuthentication`, …) — customers who need them can attach against the underlying `userPool` construct directly.
- **Auth flows other than `USER_PASSWORD_AUTH`** — widened typing only.

## `fetchAuthSession` — intentional token egress

The general design keeps Cognito tokens on the server (see *Cookie + Session Architecture* below). `fetchAuthSession(context, options?)` is the **one** API that deliberately hands tokens back to the caller, in a standard `AuthSession` shape. Two legitimate reasons to use it:

1. **Calling a different AWS service that accepts a Cognito JWT directly** — e.g. API Gateway with a Cognito authorizer, an AppSync with a Cognito auth mode, or a Bedrock / KB endpoint the Lambda needs to invoke on behalf of the user rather than with the Lambda's own IAM role.
2. **Mounting the tokens into a response** that a trusted downstream proxy forwards onward.

It is **not** the right tool for identity checks on the current request — `requireAuth` / `getCurrentUser` are cheaper (no JWT decode round-trip, no refresh path). The method auto-refreshes if the access token has expired, and `{ forceRefresh: true }` rotates unconditionally (useful after an out-of-band group/attribute change where the caller wants the new claims to appear immediately).

The `AuthSession` shape follows a conventional structure, so callers work with a familiar surface. `credentials` / `identityId` are not populated: Blocks uses User Pools only, not Identity Pools; to call AWS from the browser, use the Lambda's IAM role rather than vending temporary credentials to the client.

## Infrastructure (CDK)

Creates under the construct's scope:

- **`AWS::Cognito::UserPool`** — MFA mode + types, password policy, custom attributes, device tracking. `selfSignUpEnabled` defaults to `true`. `autoVerify: { email: true }`. `removalPolicy` threaded from options (defaults to `DESTROY` for sandbox ergonomics).
- **`AWS::Cognito::UserPoolClient`** — no secret (BFF model; client is server-side). Explicit auth flows: `USER_PASSWORD_AUTH` + `REFRESH_TOKEN_AUTH`.
- **`AWS::Cognito::UserPoolGroup`** × N — one per entry in `groups[]`.
- **Nested `AppSetting(this, 'session-secret', { secret: true })`** — SSM SecureString HMAC for signing session-ID cookies. `AppSetting` handles the custom-resource wiring (CF can't create SecureString natively) and grants `ssm:GetParameter` + `kms:Decrypt` to `this.handler` automatically. Both the CDK layer and AWS runtime instantiate an `AppSetting` at the same scope path, so each side derives the same SSM parameter name without a dedicated env var.
- **Nested `KVStore(this, 'sessions', { removalPolicy })`** — DynamoDB table holding server-side session records.

The Lambda handler receives env vars `BLOCKS_AUTH_COGNITO_<UPPER_FULLID>_{USER_POOL_ID, CLIENT_ID, REGION}` so the AWS runtime can discover the pool/client IDs without CfnOutput round-trips. IAM grants are scoped to the pool ARN: a base policy statement covering the 17 client-facing Cognito actions (sign-up, sign-in, MFA, devices, self-service password/attribute mutations, `GlobalSignOut`) is always attached. `cognito-idp:Admin*` / `cognito-idp:List*` actions are granted **only** when the `admin` option is set — a second statement whose action set is scoped by `admin.actions` (`'groups'` and/or `'lifecycle'`). Omit `admin` and the synthesized role is byte-identical to the client-only grant (least privilege by default). See *Admin surface*.

`userPoolName` is `this.fullId`; the construct throws at synth time if the ID exceeds Cognito's 128-char limit.

## Cookie + Session Architecture

**Trust model.** The browser sends `{username, password}` to the customer's Lambda over TLS; the Lambda forwards it to Cognito. The customer's Lambda is inside the user's trust boundary by design — the same as every server-mediated auth library (NextAuth, Devise, Spring Security, `AuthBasic`).

**Cookie.** `auth_<fullId>=<hmac_signed_session_id>`, `HttpOnly; Secure; SameSite=None; Partitioned; Path=/`. `Max-Age` defaults to 400 days (the modern cross-browser upper bound — Chrome / Firefox / Safari all cap cookie lifetimes at ~400 days regardless of what the server requests). The cookie is a **pure pointer**: the server is the source of truth on session validity.

**Session record.** Stored in the nested `KVStore` as the minimum tuple of tokens:

```typescript
interface SessionRecord {
  idToken:      string;  // Cognito ID JWT — verified once at sign-in
  accessToken:  string;  // Cognito access JWT — used for self-service SDK calls
  refreshToken: string;  // Cognito refresh token
}
```

Everything else (`username`, `userSub`, `groups`, `attributes`) is derived on read from the ID token's claims via `decodeIdToken()`. Denormalized fields were intentionally dropped: they were snapshots at sign-in and drifted after `updateUserAttributes` or a group-membership change.

**On sign-in / confirm-sign-in.** Verify Cognito's ID token **once** via `aws-jwt-verify`. Create the session record. Mint a random session ID. Sign with HMAC using the SSM-backed secret. Set the cookie.

**On `requireAuth` / `getCurrentUser`.** Read the cookie → HMAC-verify the session ID → look up the `SessionRecord` in KVStore. If the record exists and the ID token's `exp` is in the future, derive the `CognitoUser` from the ID token claims and return it. No per-request JWKS fetch; no per-request JWT signature verification.

**Dead-cookie cleanup.** If the session ID verifies but the record is missing (TTL'd, explicitly deleted, or the table got wiped), the runtime clears the cookie on the response so the browser stops sending it.

**Token refresh.** When the ID token's `exp` is in the past but the refresh token is still valid, call `InitiateAuthCommand({ AuthFlow: 'REFRESH_TOKEN_AUTH' })` transparently, update the `SessionRecord`, and the cookie's `Max-Age` sliding window stays aligned. A failed refresh clears the cookie.

**Session lifetime.** Currently bounded by the cookie's `Max-Age` (configurable via `sessionTtlSeconds`, defaults to 400 days) and by the refresh token's TTL at the pool level. Because the server is authoritative, operators can invalidate a session by deleting its KVStore entry — no need to rotate the HMAC secret.

**Challenge envelopes.** The challenge token returned by `signIn` on MFA / `NEW_PASSWORD_REQUIRED` is a small HMAC-signed envelope the client echoes back in `confirmSignIn`. Cognito's raw session token never reaches the browser; the envelope carries enough state to reconstruct `ChallengeResponses` on the server.

## Admin surface (`auth.admin`)

Server-side group-membership and user-lifecycle administration is exposed as an **opt-in handle on this class**, not a separate Building Block. Enable it by passing an `admin` options object; the handle grants the matching `Admin*` / `List*` IAM (scoped by `admin.actions`). This keeps the admin/client API distinction structural while avoiding a second package, its `/internal` mock-state-sharing port, and cross-construct wiring — the handle mutates the same live `state`/pool the client methods use. See [BB-auth-cognito-admin-implementation-plan.md](../../docs/tech-design/BB-auth-cognito-admin-implementation-plan.md) for the full rationale and the package-vs-handle trade study.

- **Compile-time gate.** The getter's type is `AdminGetterOf<O> = O extends { admin: object } ? AdminSurface<O> : AdminDisabled`. Without an `admin` object, `auth.admin` is `AdminDisabled` and any access is a compile error whose message names the fix; the getter also throws at runtime for untyped JS callers. Group names on the methods narrow via `GroupOf<O>`.
- **`actions` scopes the IAM grant, not the typed method set.** `AdminSurface<O>` is always the full `GroupAdmin<O> & LifecycleAdmin<O>`. Narrowing the *type* by `actions` via a conditional over `O` would force `AuthCognito<O>` invariant (it broke assignability across the codebase — verified), so `actions` scopes only the CDK grant. Calling a method whose action wasn't granted fails at runtime with an IAM `AccessDenied`.
- **Not an access boundary.** Like every block on the shared backend Lambda, client and admin run under one role; separation is by API surface + lint, not IAM. Gate every admin route behind `requireRole`.
- **Session freshness.** `revokeUserSessions` revokes Cognito refresh tokens (AWS: `AdminUserGlobalSignOut`; mock: deletes session records). On AWS an already-issued access token stays valid until it expires, so `checkAuth` does not flip immediately — a known mock-vs-AWS parity difference. Group changes likewise apply on the next sign-in / `fetchAuthSession({ forceRefresh: true })`, not to a live session.

## Options Split: `AuthCognitoOptions` vs `AuthCognitoMockOptions`

`AuthCognitoOptions` is the cross-runtime option type — CDK, AWS, and mock all accept it. The mock entry accepts a widened type:

```typescript
export interface AuthCognitoMockOptions extends AuthCognitoOptions {
  codeDelivery?: CodeDeliveryFn;  // mock-only hook; AWS ignores
}
```

`codeDelivery` is a mock-only callback invoked whenever a 6-digit code is generated (`signUp`, `resetPassword`, MFA setup, attribute verification). It is not re-exported from the umbrella `blocks` package, so application code that passes `codeDelivery` to the AWS runtime is a TypeScript error.

## Mock Implementation

The mock is a plain `Map<username, UserRecord>` persisted atomically (tmp-file + rename) to `.bb-data/<fullId>/state.json` via `getMockDataDir(this)`. Corrupt state files are moved to `state.json.corrupt-<timestamp>` on load so a bad file doesn't brick dev.

Mock tokens are real JWT-shaped base64url strings (header.payload.signature, fixed placeholder signature) so the production `decodeIdToken` / `jwtExpMs` helpers parse them without branching. The AWS runtime never sees mock tokens.

Session records live in the same nested `KVStore` as production, using `bb-kv-store`'s JSON-on-disk mock — so the session code path is identical in both runtimes.

Mock-only ergonomics:

- `options.codeDelivery` — callback invoked when a 6-digit code is issued.
- `.bb-data/<fullId>/last-code.json` — most recently issued code written to disk so e2e tests can read it without plumbing a callback through every call site.
- State resets: `rm -rf .bb-data`.
- Passwords are stored in plaintext (dev store only — **never** used for real auth).

## Mock vs AWS Behavior Differences

| Gap | Impact | Mitigation |
|---|---|---|
| No Cognito wire-format exercise in mock | Marshalling/serialization bugs invisible to unit tests | Sandbox e2e exercises the real SDK against a real User Pool |
| MFA accepts any 6-digit code in mock | Challenge-response logic not exercised end-to-end locally | Real codes only in sandbox |
| No email / SMS delivery in mock | Codes not transmitted | Captured via `codeDelivery` hook + written to `last-code.json` for tests |
| No Cognito Lambda triggers | `preSignUp` / `postConfirmation` / etc. not run | Customers attach triggers against the underlying `userPool` construct directly when they need them |
| No advanced security (adaptive auth, compromised creds) | Feature absent locally | Sandbox required |
| No account-level rate limiting | Throttle logic untested | Doc-only |
| Password policy validation may drift | Mock regex may diverge from Cognito's exact rules | Superset of AWS rules enforced locally |
| Mock passwords in plaintext | Dev store only | `.bb-data/` must be git-ignored |

Resolved by the MFA_SETUP + USER_AUTH work:

- ✅ MFA_SETUP now runs the full `AssociateSoftwareToken` → `VerifySoftwareToken` → `RespondToAuthChallenge` ceremony in the AWS runtime; the mock mirrors the address-submit-then-confirm UX for EMAIL setup so `AuthState` sequences line up in both modes.
- ✅ USER_AUTH passwordless (email-OTP / SMS-OTP) + first-factor selection flow through the same state-machine action surface. New payload shapes (`{ password }`, `{ firstFactor }`, `{ email }`) are driven end-to-end through the mock's `setAuthState` in unit tests.

## Key Design Decisions

1. **Server-side session records over client-held JWTs.** Rather than handing raw Cognito tokens to the browser (localStorage / cookies), Blocks holds the tokens server-side keyed by an opaque session ID. Upside: Cognito tokens never reach the browser; server is authoritative on validity; operators can invalidate sessions without rotating secrets. Downside: every request hits the session KVStore (single-digit-ms DynamoDB read).
2. **`AuthFlowType` runtime-throw instead of silent pass on unimplemented flows.** Typing exposes the full Cognito union so customer code doesn't need to cast, but passing `USER_SRP_AUTH` etc. throws at synth time (and again at runtime as defense-in-depth). Surfaces the unsupported config at deploy time, not at first login.
3. **Group membership from the ID-token `cognito:groups` claim, not a runtime `AdminListGroupsForUser` call.** `requireRole` decodes the cached ID token; no extra Cognito API call per request. Group changes take effect at the next sign-in (or next refresh), which is the same behavior Cognito exhibits for any client reading the token.
4. **Mock + AWS runtimes share the session/cookie code path.** `SessionStore`, cookie helpers, JWT decode — all shared. The only divergence is that mock issues placeholder-signature JWTs and never talks to Cognito.
5. **Error constants mirror Cognito's wire-format exception names.** Every value equals the name Cognito puts on the wire, so `isBlocksError(e, AuthCognitoErrors.X)` works identically for errors thrown by the mock (matched name directly) and errors propagated from the AWS SDK (name preserved when re-thrown as `ApiError`).
6. **`GroupNotFound` maps to `ResourceNotFoundException`.** Real Cognito returns `ResourceNotFoundException` (not the intuitive `GroupNotFoundException`) for a missing group. The constant name preserves the semantic label while the value matches what Cognito actually returns.
7. **Admin surface as an opt-in `auth.admin` handle, not a separate Building Block.** The admin/client distinction is preserved by the handle (and the `admin` opt-in gate) rather than by a second package. This removes a whole package, an `/internal` subpath for sharing mock state, and cross-construct wiring, at the cost of independent versioning (not needed). Because narrowing the typed method set by `admin.actions` would make `AuthCognito<O>` invariant, `actions` scopes the IAM grant only; the typed surface is always the full set. Full trade study in [BB-auth-cognito-admin-implementation-plan.md](../../docs/tech-design/BB-auth-cognito-admin-implementation-plan.md).
