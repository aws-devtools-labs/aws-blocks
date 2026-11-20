# AWS CDK Blocks Next.js App

A Next.js 16 App Router frontend on CDK Blocks. Shows both halves of the App
Router calling the same CDK Blocks backend: a **Server Component** that fetches on
the server, and a **Client Component** that calls the API from the browser.

## Getting Started

```bash
npm run dev          # Start the Next.js dev server (mocks, no AWS needed)
npm run test:e2e     # Run the e2e test against the dev server
npm run sandbox      # Deploy to AWS sandbox
```

Open http://localhost:3000 after `npm run dev`.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: the `api` namespace (`greet`, `getServerTime`) |
| `src/app/page.tsx` | Server Component — fetches on the server |
| `src/app/client.tsx` | Client Component — calls the API from the browser |
| `src/app/layout.tsx` | Root layout |
| `src/app/error.tsx` | Route-level error boundary (catches what a section boundary doesn't) |
| `src/app/section-boundary.tsx` | Per-section error boundary, so one failing section doesn't take down the page |
| `test/e2e.test.ts` | Boots the dev server and checks the home page, CDK Blocks config, and sample API |

## What's Included

- **App Router** — Server + Client Components in `src/app/`.
- **CDK Blocks API** — a public `api` namespace (`greet`, `getServerTime`); no auth
  by default. To gate a method, add `Auth` and call
  `await auth.requireAuth(context)` first (`npm run docs Auth`).
- **Standalone output** — `next.config.ts` sets `output: 'standalone'` so the
  build packages for Lambda deployment.
- **One `tsconfig.json`**: it typechecks `src/` and `cdk-blocks/` together,
  with Node types global, so `src/` can use `process` without an error, even in a
  Client Component.

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands. Specific to this app:

| Command | Description |
|---------|-------------|
| `npm run build` | `next build` (standalone output) |
| `npm run start` | Serve the production build locally |

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

## Tests

The home-page and CDK Blocks config checks do not depend on the sample page title or API methods.
A separate `greet` test validates the sample API.
When you replace the sample API, update or delete that test to exercise your own methods.
To test an already-running app, set `TEST_URL` to its base URL; it must serve
both the home page and `/.blocks-sandbox/config.json`. The sample API test uses
the API URL from that config, including when it points to a separate backend.

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
