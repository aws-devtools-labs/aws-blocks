# Live Demo Runbook — `@aws-blocks/bb-auth-supabase`

Audience: you, presenting live. Everything below is copy-paste exact and was
verified end-to-end on 2026-07-24 (Node v20.20.2). Nothing here is optional
unless a step says "OPTIONAL".

- **Repo:** `/local/home/rhamouda/workspace/aws-blocks`
- **Package:** `/local/home/rhamouda/workspace/aws-blocks/packages/bb-auth-supabase`
- **Branch:** `supabase-auth-poc` (commit `b9f4056`, local only — not pushed)
- **Demo server:** binds `http://127.0.0.1:8787`, endpoint `POST /aws-blocks/api`
- **Local secret used:** HS256, `demo-supabase-jwt-secret` (baked into the demo default)

---

## Part A — Pre-flight (do this ~10 min BEFORE the demo, not on stage)

Run each block; the "EXPECT" line tells you exactly what a healthy result looks like.

### A1. Open two terminals
You will use **Terminal 1** for the server and **Terminal 2** for curl. This
is cleaner on stage than backgrounding the process.

### A2. Confirm you are on the right branch and commit
```bash
cd /local/home/rhamouda/workspace/aws-blocks
git branch --show-current && git log --oneline -1
```
EXPECT (exactly):
```
supabase-auth-poc
b9f4056 feat(bb-auth-supabase): Supabase JWT auth Building Block (PoC)
```
If branch is NOT `supabase-auth-poc`, run: `git checkout supabase-auth-poc`

### A3. Confirm Node version
```bash
node -v
```
EXPECT: `v20.20.2` (any v20.x or v22.x works; the demo needs global `fetch`, i.e. Node ≥ 18).

### A4. Build the package (compiles TypeScript → `dist/`)
```bash
cd /local/home/rhamouda/workspace/aws-blocks
npm run build -w packages/bb-auth-supabase
```
EXPECT: last lines show the `tsc --build` step and the shell returns to the prompt with **no** `error TS...` lines. Verify the output exists:
```bash
ls packages/bb-auth-supabase/dist/index.js && echo BUILD_OK
```
EXPECT: a path line followed by `BUILD_OK`.

### A5. Run the unit tests (proves both HS256 and JWKS paths)
```bash
node --test \
  packages/bb-auth-supabase/dist/verify.test.js \
  packages/bb-auth-supabase/dist/index.test.js
```
EXPECT (tail of output):
```
# pass 15
# fail 0
```

### A6. Confirm port 8787 is free
```bash
lsof -ti :8787 || echo PORT_FREE
```
EXPECT: `PORT_FREE`. If it prints a number instead, a process is using the
port — kill it with `kill $(lsof -ti :8787)` or set a different port in Part B
(`PORT=8899 node demo/server.mjs`, and change `8787`→`8899` in every curl).

Pre-flight done. Leave both terminals open.

---

## Part B — The live demo

All commands in Part B run from the package directory. In **both** terminals:
```bash
cd /local/home/rhamouda/workspace/aws-blocks/packages/bb-auth-supabase
```

### Step 1 — [Terminal 1] Start the backend
```bash
node demo/server.mjs
```
EXPECT (stays running in the foreground):
```
supabase-demo listening on http://127.0.0.1:8787  (POST /aws-blocks/api)
```
Leave this running. Each curl below will print a `[rpc-...]`-style line here too — good for showing traffic.

> Talking point: "This is a real Blocks backend — a `Scope`, an `AuthSupabase`
> instance, and an `ApiNamespace` with a public `ping` and an auth-gated
> `whoami`. The server builds the request context exactly the way the Blocks
> dev server does."

### Step 2 — [Terminal 2] Mint a valid Supabase-style token
```bash
TOKEN=$(node demo/mint.mjs)
echo "$TOKEN"
```
EXPECT: a three-part JWT starting with `eyJhbGciOiJIUzI1NiJ9.` printed on one line.

OPTIONAL (nice visual) — decode the payload to show it's a real Supabase-shaped token:
```bash
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```
EXPECT: JSON containing `"iss": "https://proj.supabase.co/auth/v1"`,
`"aud": "authenticated"`, `"sub": "11111111-2222-3333-4444-555555555555"`,
`"email": "alice@example.com"`, `"role": "authenticated"`.

### Step 3 — [Terminal 2] Public route (no auth) → 200
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://127.0.0.1:8787/aws-blocks/api \
  -H 'content-type: application/json' \
  -d '{"apiNamespace":"api","method":"ping","args":[]}'
```
EXPECT:
```
{"ok":true,"result":{"ok":true,"message":"public route, no auth required"}}
HTTP 200
```

### Step 4 — [Terminal 2] Gated route WITHOUT a token → 401
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://127.0.0.1:8787/aws-blocks/api \
  -H 'content-type: application/json' \
  -d '{"apiNamespace":"api","method":"whoami","args":[]}'
```
EXPECT:
```
{"ok":false,"error":"Authentication required","name":"SessionExpiredException","status":401}
HTTP 401
```
> Talking point: "`whoami` calls `auth.requireAuth(context)`. No token → the
> block throws a Blocks `ApiError` with status 401 and name
> `SessionExpiredException`."

### Step 5 — [Terminal 2] Gated route WITH a valid token → 200 + claims
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://127.0.0.1:8787/aws-blocks/api \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"apiNamespace":"api","method":"whoami","args":[]}'
```
EXPECT:
```
{"ok":true,"result":{"userId":"11111111-2222-3333-4444-555555555555","email":"alice@example.com","role":"authenticated"}}
HTTP 200
```
> Talking point: "Same endpoint, now with a bearer token. The block verifies
> the JWT **locally** with `jose` and maps the Supabase claims onto the common
> Blocks `AuthUser` — `userId`, `email`, `role`. No network round-trip to
> Supabase."

### Step 6 — [Terminal 2] Gated route WITH a tampered token → 401
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://127.0.0.1:8787/aws-blocks/api \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.bad" \
  -d '{"apiNamespace":"api","method":"whoami","args":[]}'
```
EXPECT:
```
{"ok":false,"error":"Authentication required","name":"SessionExpiredException","status":401}
HTTP 401
```
> Talking point: "Bad signature → rejected. The verifier enforces signature,
> issuer, audience, and expiry."

### Step 7 — [Terminal 1] Stop the server
Press `Ctrl+C` in Terminal 1.

---

## Part C — OPTIONAL deep-dives (if asked / time permits)

### C1. Show the whole thing is ~2 files of real logic
```bash
sed -n '1,90p' /local/home/rhamouda/workspace/aws-blocks/packages/bb-auth-supabase/src/verify.ts
```
Point at: `decodeProtectedHeader` → `alg` branch → `jose.jwtVerify` with a
`TextEncoder` secret (HS256) **or** `createRemoteJWKSet` (ES256/RS256).

### C2. Show the BlocksAuth surface
```bash
grep -n "requireAuth\|checkAuth\|getCurrentUser\|requireRole\|implements BlocksAuth" \
  /local/home/rhamouda/workspace/aws-blocks/packages/bb-auth-supabase/src/index.ts
```

### C3. Show the new-key (asymmetric/JWKS) path is covered
The HS256 secret is only for the *legacy* Supabase era. The *new* signing-key
era (ES256/RS256 via JWKS) is proven by the unit test, which spins up a local
JWKS server:
```bash
node --test /local/home/rhamouda/workspace/aws-blocks/packages/bb-auth-supabase/dist/verify.test.js 2>&1 | grep -iE "ES256|asymmetric|pass|fail"
```
EXPECT: the ES256/JWKS subtest passes; `# pass` count with `# fail 0`.

> Talking point: "The block auto-detects the algorithm per token, so the same
> code handles legacy HS256 projects and the new asymmetric-key projects
> without configuration."

---

## Part D — Troubleshooting (symptom → exact fix)

| Symptom | Cause | Fix |
|---|---|---|
| Step 1 prints `Error: Cannot find module ... dist/index.js` | Package not built | Re-run **A4** (`npm run build -w packages/bb-auth-supabase`) |
| Step 1 prints `EADDRINUSE ... :8787` | Port already in use | `kill $(lsof -ti :8787)` then retry, OR use `PORT=8899 node demo/server.mjs` and change `8787`→`8899` in every curl |
| `node demo/mint.mjs` prints `Cannot find package 'jose'` | Deps not installed | `cd /local/home/rhamouda/workspace/aws-blocks && npm install` |
| Step 5 returns `401` with a token | `TOKEN` var empty/expired, or secret mismatch | Re-run **Step 2** in the *same* terminal; confirm `echo "$TOKEN"` prints a JWT. Tokens expire after 2h — mint a fresh one |
| curl prints `Connection refused` | Server not running / wrong terminal | Confirm Terminal 1 still shows the "listening" line; run curl in Terminal 2 |
| `git branch` shows a different branch | Wrong checkout | `cd /local/home/rhamouda/workspace/aws-blocks && git checkout supabase-auth-poc` |

---

## Part E — One-shot fallback (if the live two-terminal flow goes sideways)

Runs the whole sequence in a single command and prints all four results, then
stops the server automatically. Use this only if you need a guaranteed result.
```bash
cd /local/home/rhamouda/workspace/aws-blocks/packages/bb-auth-supabase
node demo/server.mjs >/tmp/demo.log 2>&1 & SRV=$!; sleep 1.5
TOKEN=$(node demo/mint.mjs); U=http://127.0.0.1:8787/aws-blocks/api
echo "1) ping:";            curl -s -w " [%{http_code}]\n" -X POST $U -H 'content-type: application/json' -d '{"apiNamespace":"api","method":"ping","args":[]}'
echo "2) whoami no token:"; curl -s -w " [%{http_code}]\n" -X POST $U -H 'content-type: application/json' -d '{"apiNamespace":"api","method":"whoami","args":[]}'
echo "3) whoami token:";    curl -s -w " [%{http_code}]\n" -X POST $U -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"apiNamespace":"api","method":"whoami","args":[]}'
echo "4) whoami tampered:"; curl -s -w " [%{http_code}]\n" -X POST $U -H 'content-type: application/json' -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.bad" -d '{"apiNamespace":"api","method":"whoami","args":[]}'
kill $SRV
```
EXPECT: results with `[200]`, `[401]`, `[200]`, `[401]` respectively.

---

## 60-second narrative (say this while Steps 3–6 run)

"A common way to authenticate Supabase-backed apps is per-app middleware,
locked to one framework, that introspects the token on every request. This
block replaces that: it's a first-class AWS Blocks Building Block that any
Blocks API can use in one line —
`await auth.requireAuth(context)` — and it validates the Supabase JWT locally,
supporting both the legacy HS256 secret and the new asymmetric signing keys.
What you just saw: public routes stay open, protected routes reject missing and
tampered tokens with a 401, and accept a valid token — returning the user's id,
email, and role."
