# Blocks API-Only Application

A headless JSON API service on AWS Blocks — no frontend. The starting point for a
backend behind a mobile app, a CLI, or a third-party client. Ships a public
health check plus an auth-gated CRUD resource with per-user isolation.

> "API-only" describes the interface — no web UI is served, clients talk to it
> over JSON-RPC. It still owns backend state (here a `DistributedTable`); a real
> API almost always does.

> Created with `npx @aws-blocks/create-blocks-app my-app --template api-only`

## For Coding Agents

**CRITICAL: Always read documentation from `node_modules/@aws-blocks/blocks/README.md` to understand the Building Block system and available APIs.**

**After making code changes, always run `npm run typecheck` to verify TypeScript types are correct.**

## What ships

- **Public** — `api.health()` returns `{ status, timestamp }` with no auth. A
  liveness probe for load balancers and uptime monitors.
- **Protected** — `createItem` / `listItems` / `getItem` / `updateQuantity` /
  `setQuantity` / `deleteItem`, an auth-gated CRUD resource over a
  `DistributedTable`. Every method calls `auth.requireAuth(context)`, so data is
  isolated per user, and writes use optimistic locking (`ifFieldEquals` on a
  version field). `setQuantity` is the raw compare-and-swap: pass the version you
  read, and a stale write is rejected with `ConditionalCheckFailedException`
  (HTTP 409) so the caller can re-read and retry.
- **Files** — `createUploadUrl` / `createDownloadUrl` mint presigned URLs on a
  `FileBucket`; the client PUTs/GETs the bytes directly. Both call
  `auth.requireAuth(context)` and scope the path to the caller, so a user can
  only reach their own files. `createUploadUrl` signs only the content types in
  `ALLOWED_UPLOAD_TYPES` (extend it for your app), and the bucket is versioned,
  so an overwritten file can be restored. A presigned PUT carries no size limit;
  if you need one, upload through the API with `files.put()` and check the size
  first.
- **Auth** — `AuthBasic`: callers sign up, then their items are scoped to them.

There is no `src/`, `index.html`, or web bundle — nothing is served to a browser.
Point any HTTP/JSON-RPC client at the RPC endpoint.

## Security model

- **Every `ApiNamespace` method is a public, internet-reachable endpoint.**
  Nothing is gated by default. When you add a method, start it with
  `await auth.requireAuth(context)` unless anyone on the internet may call it
  signed out (like `health`). Scope what it touches to the caller (as
  `userPath` and the `owner` key do here), not to an id or path the caller
  passes in.
- **A presigned URL is a bearer credential.** Whoever holds the URL that
  `createUploadUrl` or `createDownloadUrl` returns can write or read that one
  key until the URL expires (one hour by default; `expiresIn` sets it), without
  signing in. Mint one only in a gated method, only for a key the caller owns,
  and don't log the URL or share it.

## api-only vs backend

The `backend` template is a bare greet stub — the minimum headless backend. This
template is a **service skeleton**: auth, a real data resource, public/protected
separation, and a health check already wired up. Start here when you know you are
building an API for a client, not learning from an empty backend.

## Commands

```bash
npm run typecheck   # Check TypeScript types (run after code changes)
npm run dev         # Local dev server on http://localhost:3001 (long-running)
npm run dev:stop    # Stop the dev server this app started
npm run sandbox     # Deploy to AWS sandbox
npm run sandbox:deploy # Deploy to AWS once and exit (no watch)
npm run deploy      # Deploy to production
npm run test:e2e    # Run end-to-end tests against the dev server
npm run sandbox:destroy  # Tear down the AWS sandbox stack (asks first in a terminal; -- --yes skips it)
npm run destroy          # Tear down the production stack (asks first; -- --yes in CI)
npm run secret -- set KEY # Set a secret (also list, remove KEY)
npm run config -- set KEY value # Set a config value (also list, remove KEY)
npm run typegen          # Regenerate secret/config key types; run once and commit .blocks/hosting-values.d.ts before gating CI on -- --check
```

Each script is an alias of the `cdk-blocks` CLI that ships with `@aws-blocks/blocks` (for example
`"deploy": "cdk-blocks deploy"`); run `npx --no -- cdk-blocks --help` to see every command and its options.
The dev server settings (port; `"frontend": false` keeps it backend-only) are in `package.json` under `"blocks": { "dev": … }`.
`npm run destroy` asks before it deletes anything; in CI or a script, run `npm run destroy -- --yes`.

### RPC endpoint (local dev)

```bash
# The health check is public — no cookie needed:
curl -X POST http://localhost:3001/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.health","params":[],"id":1}'
# method = "<namespace>.<methodName>"; params = positional array.
# Protected methods require an auth cookie (sign up via the auth namespace first).
# Errors return HTTP 200 with an {"error":{...}} body (JSON-RPC), not a non-2xx status.
```

## Stack naming

Your CloudFormation stack names derive from the `stackId` in
`.blocks/config.json`, generated at scaffold time. Edit `stackId` to rename, or
`aws-blocks/index.cdk.ts` for dynamic naming logic.

## Adding a frontend later

This template is backend-only. The `backend` template's README documents adding a
Vite/React frontend and `Hosting` — the same steps apply here.

**Read `node_modules/@aws-blocks/blocks/README.md` for complete documentation.**
