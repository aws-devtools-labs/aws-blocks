# Platform app (AWS Blocks)

This is the **api-only** service, set up to run on a **shared app platform**: one AWS account that hosts many apps (often written by AI coding agents) and deploys them through one pipeline. The platform keeps apps apart with IAM; this template carries everything an app needs for that, so nobody has to remember it.

## What the template sets

| Where | What | Why |
|---|---|---|
| `aws-blocks/index.cdk.ts` | `defaults.app: { id: APP_ID, strict: true }` | Tags every resource and role `app=<id>`, and fails synth if anything reaches outside the app. |
| `aws-blocks/index.cdk.ts` | `defaults.permissionsBoundary` (`APP_PERMISSIONS_BOUNDARY`, default `apps-boundary`) | The platform's boundary policy on every role the app creates. |
| `aws-blocks/index.cdk.ts` | stack name `<id>` (`<id>-<sandbox>` for a sandbox) | Every name AWS Blocks derives starts with the stack name, so it starts with the app id. |
| `package.json` | `npm run check:iam` | Runs `blocks-iam-check --app "$APP_ID"`, the check the pipeline runs. |
| `AGENTS.md` | "Platform rules" | Rules for coding agents. |

`APP_ID` (1–10 lowercase letters and digits) is set by the platform's pipeline, from its own registry. For a sandbox, export it yourself: `APP_ID=<your app id> npm run sandbox`.

## What the platform team provides

Generate the two policies the platform needs from a synthesized app:

```bash
APP_ID=<id> npx cdk synth --quiet
npx blocks-iam-policies cdk.out --out iam --app <id> --account <account>
```

- `iam/boundary.json`: the permissions boundary, one policy for every app in the account. Create it once as `apps-boundary`.
- `iam/execution-<id>.json`: this app's CloudFormation execution policy. Bootstrap the app with the app id as its qualifier and pass it: `cdk bootstrap --qualifier <id> --toolkit-stack-name CDKToolkit-<id> --cloudformation-execution-policies <arn>`. `aws-blocks/index.cdk.ts` already sets the qualifier from `APP_ID`, so synth and `npm run check:iam` need nothing else. The pipeline deploys the checked assembly with `cdk deploy --app cdk.out --toolkit-stack-name CDKToolkit-<id>`. AWS Blocks' own `npm run deploy` / `npm run sandbox` check the bootstrap using the qualifier in `cdk.json`: scaffolding with `APP_ID` set writes it there (with `"toolkitStackName": "CDKToolkit-<id>"`); otherwise add both by hand.
- An app whose roles call its own APIs through `execute-api` (a Realtime WebSocket API) needs its own boundary: after the first deploy, regenerate with `--api-id <api id>`, which writes `iam/boundary-<id>.json`, and set `APP_PERMISSIONS_BOUNDARY` to it.
- `iam/deploy-guard-<id>.json`: attach it to the app's deploy role (`cdk-<id>-deploy-role-<account>-<region>`), so this app's pipeline can only change this app's stacks.

The pipeline then runs `npx blocks-iam-check cdk.out --app <id>` after synth and before the deploy gets credentials, and fails on any non-zero exit. See the `@aws-blocks/core` README section "Running many apps in one AWS account".

---


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
- **Auth** — `AuthBasic`: callers sign up, then their items are scoped to them.

There is no `src/`, `index.html`, or web bundle — nothing is served to a browser.
Point any HTTP/JSON-RPC client at the RPC endpoint.

## api-only vs backend

The `backend` template is a bare greet stub — the minimum headless backend. This
template is a **service skeleton**: auth, a real data resource, public/protected
separation, and a health check already wired up. Start here when you know you are
building an API for a client, not learning from an empty backend.

## Commands

```bash
npm run typecheck   # Check TypeScript types (run after code changes)
npm run dev         # Local dev server on http://localhost:3001 (long-running)
npm run sandbox     # Deploy to AWS sandbox
npm run sandbox:deploy # Deploy to AWS once and exit (no watch)
npm run deploy      # Deploy to production
npm run test:e2e    # Run end-to-end tests against the dev server
npm run sandbox:destroy  # Tear down the AWS sandbox stack
npm run destroy          # Tear down the production stack
```

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
