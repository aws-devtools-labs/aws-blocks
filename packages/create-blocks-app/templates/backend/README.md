# Blocks Backend Application

Backend-only TypeScript API with AWS Blocks — no frontend included.

> Created with `npx @aws-blocks/create-blocks-app my-app --template backend`

## For Coding Agents

**CRITICAL: Always read documentation from `node_modules/@aws-blocks/blocks/README.md` to understand the Building Block system and available APIs.**

**After making code changes, always run `npm run typecheck` to verify TypeScript types are correct.**

## Documentation Location

**All Blocks documentation is in `node_modules/@aws-blocks/blocks/README.md`:**

The Blocks package handles infrastructure, backend logic, APIs, storage, authentication, and more through Building Blocks. Read the README to discover available Building Blocks and their usage.

## For Humans

**Hover in IDE:** Import a Building Block and hover over it to see comprehensive docstrings with usage, best practices, and performance characteristics.

## Commands

```bash
npm run typecheck   # Check TypeScript types (run after code changes)
npm run dev         # Local dev server (long-running - use background job)
npm run sandbox     # Deploy to AWS sandbox
npm run deploy      # Deploy to production
npm run test:e2e    # Run end-to-end tests against dev server
```

## Local dev vs Sandbox vs Deploy (process model)

| Command | Backend | API URL |
|---------|---------|---------|
| `npm run dev` | Local RPC dev server on http://localhost:3001 | `http://localhost:3001` |
| `npm run sandbox` | Deployed to AWS, `cdk watch --hotswap` keeps it in sync | Deployed API Gateway URL |
| `npm run deploy` | Deployed to AWS | Deployed API Gateway URL |

### RPC endpoint (local dev)

```bash
# The dev server's RPC endpoint is JSON-RPC 2.0 at POST /aws-blocks/api:
curl -X POST http://localhost:3001/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.greet","params":["World"],"id":1}'
# method = "<namespace>.<methodName>" (namespace = first arg of ApiNamespace); params = positional array.
# Errors return HTTP 200 with an {"error":{...}} body (JSON-RPC), not a non-2xx status.
```

## Architecture

- **Backend:** `aws-blocks/index.ts` — Define APIs and Building Blocks
- **Infrastructure:** Inferred from code, works locally and on AWS

**Read `node_modules/@aws-blocks/blocks/README.md` for complete documentation.**

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<sandboxId>`, where `sandboxId` is a per-machine random ID stored in `.blocks-sandbox/sandbox-id` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## Adding a Frontend Later

This template is backend-only. To add a frontend:

1. **React/Vite frontend:**
   ```bash
   npm create vite@latest src -- --template react-ts
   ```
   Then add to `package.json` (rename existing `dev` → `dev:server`):
   ```json
   {
     "scripts": {
       "build": "tsc && vite build",
       "dev:server": "tsx watch aws-blocks/scripts/server.ts",
       "dev:client": "vite",
       "dev": "concurrently \"npm:dev:server\" \"npm:dev:client\""
     },
     "dependencies": {
       "react": "^19.0.0",
       "react-dom": "^19.0.0"
     },
     "devDependencies": {
       "@vitejs/plugin-react": "^4.3.0",
       "vite": "^5.0.0",
       "concurrently": "^8.2.0"
     }
   }
   ```

2. **Import APIs in your frontend:**
   ```ts
   import { api } from 'aws-blocks';
   const result = await api.greet('World');
   ```

3. **Add Hosting to `aws-blocks/index.cdk.ts`:**
   ```ts
   import { Hosting } from '@aws-blocks/blocks/cdk';

   if (!sandboxMode) {
     new Hosting(blocksStack, 'Hosting', {
       root: join(__dirname, '..'),
       buildCommand: 'npm run build',
       buildOutputDir: 'dist',
       api: blocksStack
     });
   }
   ```

The `aws-blocks` workspace package re-exports a type-safe client that works in both Node.js and browser environments.
