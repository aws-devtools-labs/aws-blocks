# AWS CDK Blocks Auth (OIDC) App

A frontend on CDK Blocks with **OpenID Connect (OIDC) / OAuth 2.0** sign-in end
to end. Users sign in with an external identity provider (Google, GitHub, Okta,
any OIDC provider); the Building Block turns the authorization-code flow into an
authenticated session your API consumes. Vite + vanilla DOM frontend.

## Getting Started

```bash
npm run dev          # Start local dev server (local stub IdP, no AWS needed)
npm run test:e2e     # Run API tests
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

**Local sign-in:** `stubIdp()` serves a real OIDC provider from the dev server
(and from a sandbox deployment), so sign-in runs the same authorize → callback →
token-verify path a real provider drives, with no IdP account. Its `onAuthorize`
hook decides who signs in (here, a single demo user). Anyone who can reach a
sandbox can sign in as the stub's users.

## Before deploying to production

Synth refuses `stubIdp()` for production, so `cdk-blocks/index.ts` picks the
provider with `getDeploymentType()`. Before `npm run deploy`:

1. Replace the production entry's `issuer` and `clientId` with your IdP's
   (Okta, Entra ID, Auth0, any OIDC provider).
2. Register `<your origin>/cdk-blocks/auth/callback` as its redirect URI.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: `Auth` (`store: 'builtin'`, stub provider locally), KVStore, an `auth.protect` API |
| `src/index.ts` | Frontend: Authenticator sign-in + per-user KV demo |
| `test/e2e.test.ts` | Tests exercising the public and protected API |
| `index.html` | HTML shell |

## What's Included

- **Auth with direct OIDC federation** (`store: 'builtin'`) — your backend
  verifies each sign-in itself and the block keeps only sessions: no Cognito
  user pool. The sign-in kickoff, callback, token exchange and session cookie
  are all owned by the block under `/cdk-blocks/auth/*`. A user's `userId` is
  `` `${issuer}:${sub}` ``.
- **Deny-by-default API** (`auth.protect`) — `ping` is the one public method;
  every method under `methods` runs only for a signed-in caller and gets the
  `user`, so a signed-out call gets `401`. `whoAmI` returns the signed-in user's
  `userId`, `email` and `name` (from the provider's claims) and `provider`.
- **KVStore** — a per-user key/value store, keyed by the `userId`, so each user
  sees only their own namespace.

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
