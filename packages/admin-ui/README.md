# @aws-blocks/admin-ui

The Blocks Admin UI — a local dashboard for Blocks applications covering deployments, logs, resources, environments, and cost.

## How it runs

Users never install this package directly. Running `npm run dashboard` in a Blocks app invokes core's `dashboard.ts`, which:

1. Lazily resolves `@aws-blocks/admin-ui` from the app (offering a one-time install if missing — the dashboard is opt-in and adds no weight for users who don't want it),
2. generates a crypto-random session token for the process,
3. boots this package's server (`src/server/start.ts`): a Next.js handler wrapped in a `node:http` server bound to `127.0.0.1`, rejecting any `/api` request without the token, and
4. opens `http://127.0.0.1:4400/#token=…` in the browser. The SPA reads the token from the fragment (never sent to the server) and presents it as an `Authorization` header.

## Architecture

```
SPA (Next.js app router, Tailwind + shadcn-style components, TanStack Query/Table)
  │  fetch /api/v1/* with Bearer token
  ▼
Dashboard API (versioned route handlers under app/api/v1/)
  │  delegates to
  ▼
DataProvider (src/server/data-provider.ts — swappable)
  └─ LocalDataProvider: .blocks state + AWS calls with local credentials
     (a future in-account provider swaps in without touching SPA or routes)
```

The SPA never talks to AWS directly. The HTTP contract lives in `src/contract/v1.ts` and is the only coupling between UI and backend.

## Development

```bash
npm run dev    # next dev on port 4400 (no token required in development)
npm run build  # tsc server build + next build
npm test       # node --test on the compiled server modules
```
