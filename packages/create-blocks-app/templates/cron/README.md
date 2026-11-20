# AWS CDK Blocks Scheduled Jobs Application

Backend-only CDK Blocks app with scheduled **CronJobs**. A `heartbeat` job runs
every minute and records each run in a `KVStore`; a second job shows
`enabled: false`. Deployed, the jobs run on EventBridge Scheduler; under
`npm run dev` the local server fires them on the same schedule. No frontend
included.

## Getting Started

```bash
npm run dev        # start the local server (leave it running)
npm run test:e2e   # waits for heartbeat's first run (about a minute)
```

`api.lastRun('heartbeat')` returns the latest run, or `null` before the first
one. Schedules take `rate(<n> minutes|hours|days)` (one minute minimum) or a
6-field `cron(...)` expression; see
`npm run docs CronJob`.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: the `heartbeat` and `paused` CronJobs, the `KVStore` of runs, the `api` namespace (`lastRun`) |
| `test/e2e.test.ts` | Tests: call the API through the typed client |

## Commands

`npm run help` lists every command. `AGENTS.md` covers the development, test and deploy commands.

`npm run typegen` regenerates the secret and config key types; run it once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`.

After code changes, run `npm run typecheck`: `npm run test:e2e` does not type-check.

## Local dev vs Sandbox vs Deploy (process model)

| Command | Backend | API URL |
|---------|---------|---------|
| `npm run dev` | Local RPC dev server on http://localhost:3001 | `http://localhost:3001/cdk-blocks/api` |
| `npm run sandbox` | Deployed to AWS, `cdk watch --hotswap` keeps it in sync | Deployed API Gateway URL |
| `npm run sandbox:deploy` | Deployed to AWS once, then exits (no watch); for scripts and CI | Deployed API Gateway URL |
| `npm run deploy` | Deployed to AWS | Deployed API Gateway URL |

### RPC endpoint (local dev)

Tests and TypeScript callers import the typed client (`import { api } from 'cdk-blocks'`). Call the endpoint directly only to troubleshoot connectivity; `AGENTS.md` describes the request format and the error responses.

```bash
# The dev server's RPC endpoint is JSON-RPC 2.0 at POST /cdk-blocks/api:
curl -X POST http://localhost:3001/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.lastRun","params":["heartbeat"],"id":1}'
```

## Stack naming

A sandbox stack's name ends in an identifier that is per machine, stored in `.cdk-blocks-sandbox/sandbox-id.txt` (gitignored). `AGENTS.md` describes the stack names and how to rename them.

## Adding a Frontend Later

This template is backend-only. To add a frontend:

1. Generate a reference app in a **separate directory** using the same CLI version as this app:
   ```bash
   npx @aws-cdk-blocks/create-blocks-app ../react-reference --template react --skip-install
   ```
   Use its root `index.html`, `vite.config.ts`, React entry point and TypeScript project layout (including `cdk-blocks/tsconfig.json`). Replace the sample React component with your own; keep this app's backend and tests.
   Merge the reference app's frontend dependencies (including the React types), `build` and `typecheck` scripts into your root `package.json`. Set `blocks.dev` to `{ "port": 3001, "frontendPort": 3100 }`, replacing `frontend: false`. Run `npm install`, then `npm run build` and `npm run test:e2e`. Keeping port 3001 lets the existing tests and `npm run dev` use the same server.

2. **Import APIs in your frontend:**
   ```ts
   import { api } from 'cdk-blocks';
   const run = await api.lastRun('heartbeat');
   ```

3. **Add Hosting to `cdk-blocks/index.cdk.ts`:**
   ```ts
   import { Hosting } from 'aws-cdk-blocks/cdk';

   if (!sandboxMode) {
     new Hosting(blocksStack, 'Hosting', {
       root: join(__dirname, '..'),
       buildCommand: 'npm run build',
       buildOutputDir: 'dist',
       api: blocksStack
     });
   }
   ```

## For Agents

Building Block docs: `npm run docs` lists the blocks, and `npm run docs <Block>...` prints their docs (`npm run docs -- --help` for more). `AGENTS.md` explains the rest.
