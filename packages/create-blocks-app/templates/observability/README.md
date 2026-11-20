# AWS CDK Blocks Observability Application

Backend-only CDK Blocks app showing the observability Building Blocks on one
API call. `api.placeOrder(item)` writes a structured log line (**Logger**),
emits an `OrdersPlaced` metric (**Metrics**) and runs inside a `placeOrder`
trace segment (**Tracer**); a **Dashboard** brings them together in CloudWatch.
`placeOrder` is gated by **Auth** (`auth.requireAuth(context)`), so it
needs a signed-in user. Sign-up confirms the email with a 6-digit code, which
`npm run dev` prints in its terminal locally. No frontend included.

## Getting Started

```bash
npm run dev        # start the local server, then sign in and call api.placeOrder
npm run test:e2e   # checks auth, the log line, metric, trace and dashboard route
```

What each one does locally and deployed:

| Building Block | Under `npm run dev` | Deployed |
|----------------|---------------------|----------|
| Logger | One JSON line per call in the terminal | CloudWatch Logs |
| Metrics | EMF JSON lines in the terminal | CloudWatch metrics, extracted from the logs |
| Tracer | Last 100 traces in `.cdk-blocks/local/data/`, each also printed | AWS X-Ray |
| Dashboard | Open `http://localhost:3001/cdk-blocks/dashboard` for the local overview; no AWS credentials needed | A CloudWatch Dashboard; the route redirects to it |

`test:e2e` reads the log and metric lines from the dev server it starts. If a
dev server is already running, it skips those two checks and runs the rest.

## Project Structure

| Path | Purpose |
|------|---------|
| `cdk-blocks/index.ts` | Backend: Logger, Metrics, Tracer, Dashboard, Auth, the `api` namespace (`placeOrder`) |
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

Tests and TypeScript callers import the typed client (`import { api } from 'cdk-blocks'`). Call the endpoint directly only to try `placeOrder` by hand or to troubleshoot connectivity; `AGENTS.md` describes the request format and the error responses.

```bash
# The dev server's RPC endpoint is JSON-RPC 2.0 at POST /cdk-blocks/api:
# placeOrder needs a signed-in user: sign up, confirm the code `npm run dev` prints
# ([auth] signUp code for me@example.com: 123456), then sign in. Keep the session cookie
# in a jar outside the project, so the session token is never committed.
curl -c /tmp/blocks-cookies.txt -b /tmp/blocks-cookies.txt -X POST http://localhost:3001/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.setAuthState","params":[{"action":"signUp","username":"me@example.com","password":"TestPass123!"}],"id":1}'
curl -c /tmp/blocks-cookies.txt -b /tmp/blocks-cookies.txt -X POST http://localhost:3001/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.setAuthState","params":[{"action":"confirmSignUp","username":"me@example.com","code":"123456"}],"id":2}'
curl -c /tmp/blocks-cookies.txt -b /tmp/blocks-cookies.txt -X POST http://localhost:3001/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.setAuthState","params":[{"action":"autoSignIn","username":"me@example.com"}],"id":3}'
curl -b /tmp/blocks-cookies.txt -X POST http://localhost:3001/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.placeOrder","params":["coffee"],"id":4}'
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
   const order = await api.placeOrder('coffee');
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
