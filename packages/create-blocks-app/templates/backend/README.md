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
npm run dev:stop    # Stop the dev server this app started
npm run sandbox     # Deploy to AWS sandbox
npm run sandbox:deploy # Deploy to AWS once and exit (no watch)
npm run deploy      # Deploy to production
npm run test:e2e    # Run end-to-end tests against dev server
npm run sandbox:destroy  # Tear down the AWS sandbox stack (asks first in a terminal; -- --yes skips it)
npm run destroy          # Tear down the production stack (asks first; -- --yes in CI)
npm run secret -- set KEY # Set a secret (also list, remove KEY)
npm run config -- set KEY value # Set a config value (also list, remove KEY)
npm run typegen          # Regenerate secret/config key types; run once and commit .blocks/hosting-values.d.ts before gating CI on -- --check
```

Each script is an alias of the `cdk-blocks` CLI that ships with `@aws-blocks/blocks` (for example
`"deploy": "cdk-blocks deploy"`); run `npx --no -- cdk-blocks --help` to see every command and its options.
The dev server settings (port; `"frontend": false` keeps it backend-only) are in `package.json` under `"blocks": { "dev": … }`.
`npm run destroy` asks before it deletes anything; in CI or a script, run `npm run destroy -- --yes`.

## Local dev vs Sandbox vs Deploy (process model)

| Command | Backend | API URL |
|---------|---------|---------|
| `npm run dev` | Local RPC dev server on http://localhost:3001 | `http://localhost:3001/aws-blocks/api` |
| `npm run sandbox` | Deployed to AWS, `cdk watch --hotswap` keeps it in sync | Deployed API Gateway URL |
| `npm run sandbox:deploy` | Deployed to AWS once, then exits (no watch); for scripts and CI | Deployed API Gateway URL |
| `npm run deploy` | Deployed to AWS | Deployed API Gateway URL |

### RPC endpoint (local dev)

```bash
# The dev server's RPC endpoint is JSON-RPC 2.0 at POST /aws-blocks/api:
curl -X POST http://localhost:3001/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.greet","params":["World"],"id":1}'
# method = "<namespace>.<methodName>" (namespace = the exported variable name in aws-blocks/index.ts: `export const api = …` → api); params = positional array.
# Errors return HTTP 200 with an {"error":{...}} body (JSON-RPC), not a non-2xx status.
```

## Architecture

- **Backend:** `aws-blocks/index.ts` — Define APIs and Building Blocks
- **Infrastructure:** Inferred from code, works locally and on AWS

**Read `node_modules/@aws-blocks/blocks/README.md` for complete documentation.**

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `.blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<username>-<random>`, where the sandbox identifier is per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `.blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## Adding a Frontend Later

This template is backend-only. To add a frontend:

Run the commands below from this app's root, next to `package.json`. Use a root-level Vite app, as in the React template; creating another project inside `src/` would put its `index.html` and configuration below the directory where the dev server and build run.

1. **Install React and Vite.** These commands use the same React 19 / Vite 6 major versions as the React template:
   ```bash
   npm install react@19 react-dom@19
   npm install --save-dev vite@6 @vitejs/plugin-react@4 @types/react@19 @types/react-dom@19
   ```

2. **Create `index.html` at the app root:**
   ```html
   <!doctype html>
   <html lang="en">
     <head>
       <meta charset="UTF-8" />
       <meta name="viewport" content="width=device-width, initial-scale=1.0" />
       <title>Blocks App</title>
     </head>
     <body>
       <div id="root"></div>
       <script type="module" src="/src/main.tsx"></script>
     </body>
   </html>
   ```

   Create `src/main.tsx`. The `aws-blocks` workspace already provides a typed browser client for the backend:
   ```tsx
   import { StrictMode, useState } from 'react';
   import { createRoot } from 'react-dom/client';
   import { api } from 'aws-blocks';

   function App() {
     const [message, setMessage] = useState('');

     async function greet() {
       try {
         const result = await api.greet('World');
         setMessage(result.message);
       } catch (error) {
         setMessage(error instanceof Error ? error.message : String(error));
       }
     }

     return (
       <main>
         <button onClick={greet}>Greet</button>
         <p role="status">{message}</p>
       </main>
     );
   }

   createRoot(document.getElementById('root')!).render(
     <StrictMode><App /></StrictMode>,
   );
   ```

3. **Create `vite.config.ts` at the app root:**
   ```ts
   import { defineConfig } from 'vite';
   import react from '@vitejs/plugin-react';

   export default defineConfig({
     plugins: [react()],
     resolve: { conditions: ['browser'] },
   });
   ```

   Add `"jsx": "react-jsx"` to the existing `compilerOptions` in `tsconfig.json`; keep its other options and `include` entries:
   ```json
   {
     "compilerOptions": {
       "jsx": "react-jsx"
     }
   }
   ```

4. **Update `package.json`.** Keep the existing dependencies, workspaces and other scripts, including `prebuild`. Change the `build` script and replace the whole `blocks.dev` value below, removing `"frontend": false`:
   ```json
   {
     "scripts": {
       "build": "tsc --noEmit && vite build"
     },
     "blocks": {
       "dev": { "port": 3001, "frontendPort": 3100 }
     }
   }
   ```

5. **Check and run the app:**
   ```bash
   npm run typecheck
   npm run build
   npm run dev
   ```

   Open http://localhost:3001 and select **Greet**. The page displays `Hello, World!` from the backend. The Blocks server proxies Vite on port 3100, while keeping the existing API URL on port 3001. Stop it with `npm run dev:stop` when finished. The existing `npm run test:e2e` also continues to use `blocks.dev.port`.

6. **Add Hosting for deployment.** Import `Hosting` and `HostingPresets` in `aws-blocks/index.cdk.ts`, then add this after `BlocksStack.create(...)`:
   ```ts
   import { Hosting, HostingPresets } from '@aws-blocks/blocks/cdk';

   if (!sandboxMode) {
     new Hosting(blocksStack, 'Hosting', {
       ...HostingPresets.production,
       root: join(__dirname, '..'),
       buildCommand: 'npm run build',
       buildOutputDir: 'dist',
       api: blocksStack,
     });
   }
   ```

   `vite build` writes to the root `dist/` directory, which matches `buildOutputDir`. A plain sandbox remains backend-only; `npm run deploy` includes the frontend.

The `aws-blocks` workspace package re-exports a type-safe client that works in both Node.js and browser environments.
