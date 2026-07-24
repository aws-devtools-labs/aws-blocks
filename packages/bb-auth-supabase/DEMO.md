# `bb-auth-supabase` — Local Demo

A runnable proof that `AuthSupabase` gates a Blocks API method by validating a
Supabase JWT over real HTTP.

The harness (`demo/server.mjs`) defines a real Blocks backend — a `Scope`, an
`AuthSupabase` instance, and an `ApiNamespace` with a public `ping` and an
auth-gated `whoami` — then serves it, constructing the per-request
`BlocksContext` exactly as the Blocks dev server does (request headers copied
into `context.request.headers`; RPC body `{ apiNamespace, method, args }`
POSTed to `/aws-blocks/api`). A local HS256 secret is used so it runs fully
offline; the same block validates the new asymmetric/JWKS tokens in
production (see `DESIGN.md`).

## Prerequisites

Build the package first (from the repo root):

```bash
npm run build -w packages/bb-auth-supabase
```

## Run

```bash
cd packages/bb-auth-supabase

# 1. Start the demo server (binds 127.0.0.1:8787)
node demo/server.mjs &

# 2. Mint a valid Supabase-style HS256 access token
TOKEN=$(node demo/mint.mjs)

U="http://127.0.0.1:8787/aws-blocks/api"

# 3a. Public route — no auth
curl -s -w "\nHTTP %{http_code}\n" -X POST "$U" \
  -H 'content-type: application/json' \
  -d '{"apiNamespace":"api","method":"ping","args":[]}'

# 3b. Gated route WITHOUT a token
curl -s -w "\nHTTP %{http_code}\n" -X POST "$U" \
  -H 'content-type: application/json' \
  -d '{"apiNamespace":"api","method":"whoami","args":[]}'

# 3c. Gated route WITH a valid Supabase token
curl -s -w "\nHTTP %{http_code}\n" -X POST "$U" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"apiNamespace":"api","method":"whoami","args":[]}'

# 3d. Gated route WITH a tampered token
curl -s -w "\nHTTP %{http_code}\n" -X POST "$U" \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.badsignature' \
  -d '{"apiNamespace":"api","method":"whoami","args":[]}'
```

Configuration is via env vars (defaults shown): `SUPABASE_URL`
(`https://proj.supabase.co`), `SUPABASE_JWT_SECRET` (`demo-supabase-jwt-secret`),
`PORT` (`8787`). `demo/mint.mjs` accepts positional overrides:
`node demo/mint.mjs [secret] [supabaseUrl] [sub] [email] [role]`.

## Verified transcript

```
=== 1) public ping (expect 200) ===
HTTP 200
{"ok":true,"result":{"ok":true,"message":"public route, no auth required"}}

=== 2) whoami WITHOUT token (expect 401) ===
HTTP 401
{"ok":false,"error":"Authentication required","name":"SessionExpiredException","status":401}

=== 3) whoami WITH valid Supabase token (expect 200 + claims) ===
HTTP 200
{"ok":true,"result":{"userId":"11111111-2222-3333-4444-555555555555","email":"alice@example.com","role":"authenticated"}}

=== 4) whoami WITH tampered token (expect 401) ===
HTTP 401
{"ok":false,"error":"Authentication required","name":"SessionExpiredException","status":401}
```

## Unit tests

```bash
npm run build -w packages/bb-auth-supabase
node --test packages/bb-auth-supabase/dist/verify.test.js \
             packages/bb-auth-supabase/dist/index.test.js
# → 15 pass, 0 fail (HS256 + ES256/JWKS verifier paths, BlocksAuth surface incl. 401/403)
```
