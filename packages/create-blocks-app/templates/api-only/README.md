# AWS CDK Blocks API-Only Application

A headless JSON API service on CDK Blocks — no frontend. The starting point for a
backend behind a mobile app, a CLI, or a third-party client. Ships a public
health check plus an auth-gated CRUD resource with per-user isolation.

## Getting Started

```bash
npm run dev         # Local dev server on http://localhost:3001 (long-running)
npm run test:e2e    # Run end-to-end tests against the dev server
npm run sandbox     # Deploy to AWS sandbox
```

## What's Included

- **Public** — `GET /healthz` is a `RawRoute` that answers a plain HTTP `GET`
  with `{ status, timestamp }` and a `Cache-Control` header that includes
  `no-store`, the shape load balancers and uptime monitors expect. Probe it
  with `GET`: `HEAD` is not routed and returns 404. `api.health()` returns the
  same over JSON-RPC for RPC clients. Neither needs auth.
- **Protected** — `createItem` / `listItems` / `getItem` / `updateQuantity` /
  `setQuantity` / `deleteItem`, an auth-gated CRUD resource over a
  `KVStore`.
  - Every method calls `auth.requireAuth(context)`, so data is isolated per
    user.
  - Writes use optimistic locking (`ifFieldEquals` on a version field).
  - `setQuantity` is the raw compare-and-swap: pass the version you read. A
    stale write is rejected with `ConditionalCheckFailedException` (HTTP 409),
    so the caller can re-read and retry.
- **Files** — `createUploadUrl` / `createDownloadUrl` mint presigned URLs on a
  `FileBucket`; the client PUTs/GETs the bytes directly. Both call
  `auth.requireAuth(context)` and scope the path to the caller, so a user can
  only reach their own files. `createUploadUrl` signs only the content types in
  `ALLOWED_UPLOAD_TYPES` (extend it for your app), and the bucket is versioned,
  so an overwritten file can be restored. A presigned PUT carries no size limit;
  if you need one, upload through the API with `files.put()` and check the size
  first.
- **Auth** — `Auth` (email + password; Amazon Cognito on AWS): callers sign up,
  confirm their email with a 6-digit code (printed in the `npm run dev` terminal
  locally), and are signed in; their items are scoped to them.

Point any HTTP/JSON-RPC client at the RPC endpoint.

## Security model

- **Every `ApiNamespace` method is a public, internet-reachable endpoint.**
  Nothing is gated by default. When you add a method, start it with
  `await auth.requireAuth(context)` unless anyone on the internet may call it
  signed out (like `health`). The same holds for a `RawRoute` handler: `/healthz`
  is public on purpose. Scope what it touches to the caller: derive the
  owner or prefix from the signed-in user (as `userPath` and the `owner` key do
  here), never from an id or owner the caller passes in.
- **A presigned URL is a bearer credential.** Whoever holds the URL that
  `createUploadUrl` or `createDownloadUrl` returns can write or read that one
  key until the URL expires (one hour by default; `expiresIn` sets it), without
  signing in. Mint one only in a gated method, only for a key the caller owns,
  and don't log the URL or share it.

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

After code changes, run `npm run typecheck`: `npm run test:e2e` does not type-check.

### Health probe (local dev)

```bash
curl -i http://localhost:3001/healthz
# HTTP/1.1 200 OK
# content-type: application/json
# cache-control: no-store, no-cache, must-revalidate, proxy-revalidate
# pragma: no-cache
# expires: 0
# …
#
# {"status":"ok","timestamp":...}
```

### RPC endpoint (local dev)

Tests and TypeScript callers import the typed client (`import { api } from 'cdk-blocks'`). Call the endpoint directly from a client in another language or to troubleshoot connectivity; `AGENTS.md` describes the request format, the error responses and the session cookie.

```bash
# The health check is public — no cookie needed:
curl -X POST http://localhost:3001/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.health","params":[],"id":1}'
# Protected methods require an auth cookie (sign up via the auth namespace first).
```

## Adding a frontend later

This template is backend-only. To add a frontend, add `Hosting` to
`cdk-blocks/index.cdk.ts` (`npm run docs core -- --section Hosting`) and remove
`"frontend": false` from the dev server settings in `package.json` (`AGENTS.md`
describes them). For a wired example, scaffold the `react` template in another
directory and compare its `package.json`, `vite.config.ts` and
`cdk-blocks/index.cdk.ts`:

```bash
npx @aws-cdk-blocks/create-blocks-app my-app --template react
```

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
