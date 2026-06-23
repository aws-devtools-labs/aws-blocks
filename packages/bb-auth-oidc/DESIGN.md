# `@aws-blocks/bb-auth-oidc` — Design Notes

Implementation notes. Customer-facing docs live in `README.md`.

## Sign-in flows

Three flows share the same `AuthOIDC` instance. Each serves a distinct transport
constraint:

| Flow | Entry point | Code delivery | Session mechanism | Use case |
|------|-------------|---------------|-------------------|----------|
| **Server-initiated** | `GET /aws-blocks/auth/signin/<provider>` | Backend exchanges at `/aws-blocks/auth/callback` | Session cookie set by backend | SSR, zero-JS, `<a>` tag sign-in |
| **Client PKCE** | Browser `AuthOIDCClient.signIn()` | IdP redirects code to browser directly | `/aws-blocks/auth/exchange` POST → session cookie | SPAs, JS-required apps |
| **Relay** | Native SDK `POST /aws-blocks/auth/authorize-params` | Backend 302s code to custom-scheme URI | `/aws-blocks/auth/exchange` POST → bearer tokens | iOS, Android, CLI tools |

**Callback dispatch.** Server-initiated and relay both land on `/aws-blocks/auth/callback`.
The dispatcher branches on pending-auth cookie presence:
- Cookie present → server-initiated (exchange code server-side, set session cookie)
- Cookie absent → relay (decode state envelope, 302 to relay target with code)

Client PKCE never hits `/aws-blocks/auth/callback` — the browser receives the code directly
from the IdP and POSTs it to `/aws-blocks/auth/exchange`.

## Engine architecture

Two engines implement the `AuthEngine` interface. Both share a `SessionManager`
for session persistence, cookie management, and the CAS-based refresh protocol.

```
                    ┌─────────────────────┐
                    │   SessionManager    │
                    │  cookies, KVStore,  │
                    │  CAS refresh        │
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              │                             │
   ┌──────────▼──────────┐     ┌───────────▼───────────┐
   │  OidcClientEngine   │     │ CognitoFederationEngine│
   │  openid-client,     │     │ plain fetch to         │
   │  PKCE, JWKS, nonce  │     │ Cognito endpoints      │
   └─────────────────────┘     └────────────────────────┘
```

**Engine selection** is automatic, by provider `kind`, and **identical in both
runtimes** (`index.aws.ts` and `index.mock.ts`):
- Any `cognito-federated` provider → `CognitoFederationEngine`
- Everything else → `OidcClientEngine`

**Mock runtime** uses `OidcClientEngine` for non-Cognito providers, resolving each
provider's issuer the same way the AWS runtime does (`resolveProviderIssuerUrl`,
shared via `utils.ts`): real providers (`google`, `customOidc`, …) resolve to
their configured `issuerUrl` and hit the real IdP locally, while only
`kind === 'stub'` resolves to the in-process stub IdP. Each provider logs its
resolved issuer at startup so the path is never silent.

A `cognitoFederated` provider builds `CognitoFederationEngine` in the mock too
(matching the AWS runtime), but Cognito federation needs a **deployed** Cognito
User Pool + app-client credentials, which only exist after `npm run sandbox` /
`npm run deploy`. So `cognitoFederated` is **not available in local `npm run dev`**:
declaring it doesn't block local dev, but a cognito-federated sign-in fails fast
with a clear message. For zero-config offline local sign-in, add an explicit
`stubIdp({ name })` provider; exercise the real Cognito flow in sandbox/deploy.

**Relay support** is available on **both** engines. `OidcClientEngine` signs the
relay state envelope with a fresh `nonce` (because `openid-client` verifies the
nonce claim against the ID token). `CognitoFederationEngine` signs the envelope
but omits `nonce` — Cognito already verified the ID token (D6), so the engine
skips nonce verification entirely. Native SDKs should not assume `nonce` is
present in the relay response when using the Cognito engine.

## SessionManager

Extracted from `OidcClientEngine` to avoid duplication. Owns:
- `writeStatefulSession` — mint session ID, write row, issue cookie
- `verifyStatefulSession` — read cookie, look up row, trigger refresh via `RefreshFn`
- `forceRefresh` / CAS protocol — per-container coalescing, stale-lock recovery
- `signOutSession` — clear cookie, delete row, return refresh token + provider for revocation
- Cookie helpers — pending-auth, session, clear

The `RefreshFn` callback receives `(refreshToken, providerName)` so the engine
can target the correct IdP's token endpoint without iterating all providers.

## Cognito federation credential flow

The customer passes `AppSetting` instances for the IdP credentials (e.g. Google
OAuth client ID/secret). These serve dual purposes:

- **CDK layer** reads `appSetting.fullId` → derives SSM parameter name →
  writes `{{resolve:ssm-secure:/path}}` into the CloudFormation template for
  Cognito IdP registration.
- **Runtime** calls `appSetting.get()` lazily on the first auth request.

The Cognito App Client credentials (internal plumbing) are auto-generated by CDK
and injected via Lambda env vars. The customer never sees them.

## Decisions

### D1 — `openid-client` over `oauth4webapi`

**Status:** Accepted.

**Rationale.** Both packages come from `panva`, the same maintainer. `oauth4webapi`
is the lower-level library; `openid-client` wraps it with helpers for discovery,
JWKS rotation, PKCE, authorize-URL construction, and code exchange. We don't
need the edge-runtime focus that `oauth4webapi` targets — Blocks BBs run on Node.js
Lambda — and the extra abstraction buys fewer lines of owned code per feature.

Trade-off: `openid-client` is heavier (it depends on `oauth4webapi` internally,
so we ship both). The bundle size is acceptable for server-side use.

If Blocks ever needs an edge-runtime variant of `AuthOIDC`, migrating to
`oauth4webapi` directly is feasible — the two APIs are closely related.

### D2 — Mock stub IdP signs with real RS256 from the start

**Status:** Accepted.

**Rationale.** Production verifies RS256 against a remote JWKS via
`openid-client` + `jose`. If the stub used HMAC instead, JWKS-fetching or
RS256-verification bugs could slip past mock tests. Instead, the stub
generates a real RS256 keypair at startup and exposes it via a JWKS endpoint,
so the engine runs the same `jose.createRemoteJWKSet` code path in both
runtimes. Extra cost: ~30 lines of `node:crypto.generateKeyPair` and JWK
export boilerplate in the stub.

### D3 — Stub IdP mounts via RawRoute, not dev attachment

**Status:** Accepted.

**Rationale.** The realtime BB uses `registerDevAttachment` because it needs the
raw HTTP server instance to mount a WebSocket server on it. The stub IdP is
plain HTTP — regular `RawRoute` registrations fit the existing dispatch loop.
This keeps the mock runtime's extra machinery to a single class extending
`Scope`.

### D4 — Cookie name derived from `fullId`, not hard-coded

**Status:** Accepted.

Cookies are named `oidc_${fullId}` so two `AuthOIDC` instances in the same
app (e.g., an admin auth and a customer auth) don't step on each other's
sessions. `fullId` already ensures uniqueness via the Scope chain.

### D5 — Integrity of the ID token on the code-grant path

**Status:** Accepted.

`openid-client` v6 does **not** signature-verify the ID token on the
authorization-code-grant path. Its stance is that HTTPS to the token endpoint
provides transport integrity — the ID token arrived inside a response fetched
over HTTPS from a URL discovered via HTTPS.

We take the same stance.

Checks we run:

- All ID-token claim checks (`iss`, `aud`, `exp`, `nonce`, required-claim presence)
- CSRF binding (`state` parameter)
- PKCE S256

Checks we skip:

- The RS256 signature on the ID token

This is fine in the AWS runtime because `allowInsecureIssuers: false` —
`openid-client` refuses HTTP issuers, so there's no way to inject a non-TLS
channel. The mock runtime allows HTTP but isn't a real threat model: the stub
IdP runs inside the same Node process, no adversary is positioned to MITM it.

### D6 — Cognito federation as a separate engine, not a provider-kind shim

**Status:** Accepted.

**Rationale.** Cognito's Hosted UI diverges from standard OIDC in 5 of 8 flow
steps (authorize URL needs `identity_provider` param, no client-side PKCE for
server-redirect, code exchange is plain POST without openid-client, ID token
verification is skipped because Cognito already verified it, user ID extraction
uses the `identities` claim). Shimming these into `OidcClientEngine` via
`if (kind === 'cognito-federated')` branches would create a second code path
inside the engine, making both harder to read.

A separate `CognitoFederationEngine` (~230 lines) with shared `SessionManager`
keeps each engine focused, avoids an `openid-client` dependency on the Cognito
path, and shares the session/cookie logic.

### D7 — `cognitoFederated()` accepts `AppSetting` instances, not `SecretLike`

**Status:** Accepted.

**Rationale.** The CDK layer needs the IdP credentials at synth time (to register
the IdP in Cognito via CloudFormation dynamic references). `SecretLike` closures
are opaque — CDK can't inspect them. `AppSetting` instances expose `.fullId`
(for the SSM parameter name) and `.get()` (for runtime resolution). This matches
the `AppSetting` secret pattern used throughout Blocks.

### D8 — Relay flow uses signed `state` param, not cookies or server-side storage

**Status:** Accepted.

**Standards compliance:**

| Step | Standard | Section |
|------|----------|---------|
| PKCE generation | RFC 7636 | §4.1–4.2 |
| CSRF binding via `state` | RFC 6749 | §10.12 |
| HTTPS redirect_uri for native apps | RFC 8252 | §7.1–7.2 |
| Loopback port wildcard | RFC 8252 | §7.3 |
| Authorization code grant | RFC 6749 | §4.1 |
| Token exchange with code_verifier | RFC 7636 | §4.5 |
| Backend relay 302 + signed envelope | — | Custom (no RFC) |
| Allowlist re-validation at callback | — | Custom (defense in depth) |

**Rationale.** The relay flow serves native/CLI clients that can't participate in
browser cookies. The SDK calls `POST /aws-blocks/auth/authorize-params` from its own HTTP
client, then opens the IdP in a system browser. The browser never loads a page on
our backend before hitting the IdP, so there's no opportunity to set a cookie.

Options considered:
- **Cookie via intermediate page** (a common alternative pattern): native app opens
  `https://backend/aws-blocks/auth/start` in the browser, backend sets cookie + redirects to
  IdP. Adds a redirect hop, forces server-side authorize-URL construction, loses
  client-side PKCE generation.
- **Server-side session store** keyed by a correlation ID: adds a storage
  dependency to an unauthenticated endpoint that needs to work at scale.
- **Signed `state` envelope** (chosen): the relay target + CSRF + app state are
  HMAC-signed into the OIDC `state` parameter, which the IdP passes through
  opaquely. Zero extra storage, zero extra redirects, PKCE stays client-side.

The callback dispatcher branches on pending-auth cookie presence:
- Cookie present → server-initiated flow (exchange code, set session, 302 to app)
- Cookie absent → relay flow (decode envelope, 302 to relay target with code)

### D9 — Stub IdP rejects custom-scheme `redirect_uri`

**Status:** Accepted.

**Rationale.** Real IdPs reject custom schemes at registration and at the authorize
endpoint. Without matching that behavior, the stub gives a false green on the
exact regression the relay design exists to prevent. The stub accepts `https://`
and loopback `http://` (127.0.0.1, [::1], localhost). `localhost` is included
because the dev server runs there and Google's OAuth also accepts it.

### D10 — Relay allowlist validates authority only; paths on `relayTo` are allowed

**Status:** Accepted.

**Rationale.** The `relayOrigin()` constructor restricts allowlist entries to
scheme+authority (no paths), but the candidate `relayTo` that SDKs send at
sign-in time may include a path (`myapp://auth/callback`,
`http://127.0.0.1:9876/callback`). The dispatcher appends `?code=&state=` via
`new URL(relay)` and `searchParams.set`, which preserves the path. Rejecting
paths on the *candidate* contradicts the documented wire format and blocks
common native patterns (iOS universal links, Android app links). The validator
now strips the path before comparing against the allowlist.

### D11 — CSRF contract is ≥32 characters (not bytes)

**Status:** Accepted.

**Rationale.** `CSRF_MIN_LENGTH` in routes.ts checks `csrf.length < 32`, which
counts UTF-16 code units (characters), not bytes. 32 random bytes base64url-
encode to ~43 characters, comfortably exceeding the floor. The contract is
stated once here: `csrf` MUST be ≥32 characters; SDKs SHOULD generate 32
random bytes (≈43 base64url chars). Source files defer to this decision rather
than restating the threshold in bytes.
