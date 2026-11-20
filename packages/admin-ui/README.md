# @aws-cdk-blocks/admin-ui

Use the CDK Blocks dashboard to inspect resources, deployments, logs, and environments in your AWS CDK Blocks application.

## How it runs

From the app directory, launch the dashboard with:

```sh
node --input-type=module -e "import { dashboard } from 'aws-cdk-blocks/scripts'; await dashboard()"
```

A fresh tab starts in **local**. Browse the app's blocks and local data without credentials or a deployed
stack. Selecting a cloud stage enables AWS reads; the tab remembers that selection on reload.

The templates do not define an `npm run dashboard` script. The launcher:

1. resolves `@aws-cdk-blocks/admin-ui` from the app, offering a one-time `npm install --save-dev` in an interactive terminal if it is missing (the package is not a dependency of core),
2. generates a crypto-random session token for the process,
3. boots this package's server (`src/server/start.ts`): a Next.js handler wrapped in a `node:http` server bound to `127.0.0.1`, rejecting any `/api` request without the token, and
4. opens `http://127.0.0.1:4400/#token=…` in the browser (the first free port from 4400, or set `await dashboard({ port: 5000 })` in the launch command). The SPA reads the token from the fragment (never sent to the server) and presents it as an `Authorization` header.

## Architecture

```
SPA (Next.js app router, Tailwind + shadcn-style components, TanStack Query/Table)
  │  fetch /api/v1/* with Bearer token
  ▼
Dashboard API (versioned route handlers under app/api/v1/)
  │  delegates to
  ▼
DataProvider (src/server/data-provider.ts — swappable)
  └─ LocalDataProvider: .cdk-blocks state + AWS calls with local credentials
```

The SPA never talks to AWS directly. The HTTP contract lives in `src/contract/v1.ts` and is the only coupling between UI and backend.

## Development

```bash
# next dev on 127.0.0.1:4400. Reads need no token, but only with the opt-in below:
# the gate is default-deny and is NOT inferred from NODE_ENV.
BLOCKS_DASHBOARD_ALLOW_UNAUTHENTICATED_READS=1 npm run dev

npm run build  # tsc server build + next build
npm test       # node --test on the compiled server modules
```

The dev server binds loopback on purpose. With the read opt-in set there is no
authentication for reads, and cloud reads use your own AWS credentials, so it
must not be reachable from another machine. Writes never take the opt-in.
