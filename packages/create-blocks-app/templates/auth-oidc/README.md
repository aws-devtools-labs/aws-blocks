# Blocks Auth (OIDC) App

A frontend on AWS Blocks with **OpenID Connect (OIDC) / OAuth 2.0** sign-in end
to end. Users sign in with an external identity provider (Google, GitHub, Okta,
any OIDC provider); the Building Block turns the authorization-code flow into an
authenticated session your API consumes. Vite + vanilla DOM frontend.

> Created with `npx @aws-blocks/create-blocks-app my-app --template auth-oidc`

## Getting Started

```bash
npm run dev          # Start local dev server (local stub IdP, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
npm run sandbox:deploy # Deploy to AWS once and exit (no watch)
```

Open http://localhost:3000 after `npm run dev`.

**Local sign-in:** in mock/dev there is no real identity provider, so the
`stubIdp` provider mounts an **in-process stub IdP** that signs real RS256
tokens with its own keypair — exercising the same JWKS-fetch + token-verify path
a real provider drives, with no credentials. Its `onAuthorize` hook decides who
signs in (here, a single demo user). To use a real provider, swap `stubIdp(...)`
for `google(...)` / `github(...)` / `customOidc(...)` in `aws-blocks/index.ts`
and supply `clientId` / `clientSecret` from a `Secret`.

## Project Structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: AuthOIDC (stub provider), KVStore, requireAuth-gated API |
| `src/index.ts` | Frontend: Authenticator sign-in + per-user KV demo |
| `test/e2e.test.ts` | Tests exercising the public and protected API |
| `index.html` | HTML shell |

## What's Included

- **AuthOIDC (OpenID Connect sign-in)** — an authorization-code flow turned into
  a server-side session. The `stubIdp` provider gives credential-free local
  sign-in; the sign-in kickoff, callback, token exchange and session cookie are
  all owned by the BB under `/aws-blocks/auth/*`. Sessions outlive the IdP's ID
  token TTL via background refresh and are invalidated server-side on sign-out.
- **requireAuth-gated API** — `whoAmI` returns the signed-in user's
  `userId` / `email` / `name` / `provider`; it (and the KV methods) throw `401`
  for a signed-out caller.
- **KVStore** — a per-user key/value store, keyed by the OIDC `userId`, gated by
  `auth.requireAuth(context)` so each user sees only their own namespace.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev with the stub IdP + mock storage |
| `npm run dev:stop` | Stop the local dev server this app started |
| `npm run test:e2e` | Test the API via direct imports |
| `npm run typecheck` | TypeScript type checking |
| `npm run sandbox` | Deploy backend to AWS, serve frontend locally |
| `npm run sandbox:deploy` | Deploy the backend to AWS once and exit (no watch, no dev server); for scripts and CI |
| `npm run sandbox:preview` | Deploy a hosted preview: the sandbox backend plus the app in preview shape (API Gateway, no CloudFront); prints the URL. Same stack as `sandbox`: a plain sandbox deploy removes the preview, and re-adding it gives a new URL. Tear down with `npm run sandbox:destroy` |
| `npm run deploy` | Full production deploy |
| `npm run sandbox:destroy` | Tear down sandbox resources; asks first in a terminal (`-- --yes` skips it) |
| `npm run destroy` | Tear down the production stack (asks first; `-- --yes` in CI) |
| `npm run secret -- set KEY` | Set a secret (also `list`, `remove KEY`) |
| `npm run config -- set KEY value` | Set a non-secret config value (also `list`, `remove KEY`) |
| `npm run typegen` | Regenerate secret/config key types; run it once and commit `.blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check` |

Each script is an alias of the `cdk-blocks` CLI that ships with `@aws-blocks/blocks` (for example
`"deploy": "cdk-blocks deploy"`); run `npx --no -- cdk-blocks --help` to see every command and its options.
The dev server settings are in `package.json` under `"blocks": { "dev": … }`; `npm run dev -- --port 4000 --frontend-port 4100` overrides them.
`npm run destroy` asks before it deletes anything; in CI or a script, run `npm run destroy -- --yes`.

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in
`.blocks/config.json`, generated at scaffold time from your project name plus a
random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod`
and sandbox as `<stackId>-<username>-<random>`. To rename, edit `stackId`, or
`aws-blocks/index.cdk.ts` for dynamic naming logic.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all
data persistence and cloud abstractions (they mock locally and deploy to AWS
automatically). Start in `aws-blocks/index.ts` (backend) and `src/index.ts`
(frontend). Test via `npm run test:e2e`.
