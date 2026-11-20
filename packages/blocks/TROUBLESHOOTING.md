# Troubleshooting

## Finding the API URL

Each target has its own file in `.cdk-blocks-sandbox/`:

```bash
cat .cdk-blocks-sandbox/config.json             # the running dev server (npm run dev, or the one npm run sandbox runs)
# {"apiUrl":"http://localhost:3000/cdk-blocks/api","environment":"local"}
cat .cdk-blocks-sandbox/config.sandbox.json     # the last sandbox deploy
# {"apiUrl":"https://<id>.execute-api.<region>.amazonaws.com/prod/cdk-blocks/api","environment":"sandbox"}
cat .cdk-blocks-sandbox/config.production.json  # the last production deploy
# {"apiUrl":"https://<id>.execute-api.<region>.amazonaws.com/prod/cdk-blocks/api","environment":"production"}
```

Only a dev server writes `config.json`, and the Node.js client reads it, so a deploy never redirects local tests or scripts to AWS. In production with Hosting, browser requests go through CloudFront (same-origin at `/cdk-blocks/api`), but `config.production.json` still contains the underlying API Gateway URL.

### Over HTTP the config lives at `/.blocks-sandbox/config.json`

The browser client fetches its config from the **dotted** path `/.blocks-sandbox/config.json`. `/config.json` is not a route in local dev or in production, so a 404 there tells you nothing:

```bash
curl http://localhost:3000/.blocks-sandbox/config.json
# → {"apiUrl":"http://localhost:3000/cdk-blocks/api","environment":"local"}

curl -o /dev/null -w '%{http_code}\n' http://localhost:3000/config.json
# → 404   (expected, this path never existed)
```

`{"_placeholder":true}` is also expected in one place: the Hosting construct writes that stub into the frontend build output during CDK synth so the static route exists while the real `apiUrl` is still an unresolved CloudFormation token, and the deploy uploads the resolved config over it. Seeing it in `dist/.blocks-sandbox/config.json`, or on the origin between synth and deploy, is not a broken config. A **deployed** origin still serving the stub after a successful deploy is a real bug.

## RPC Wire Protocol

The typed client (`import { api } from 'cdk-blocks'`) handles all RPC automatically. This section is for low-level troubleshooting only.

**Format:** JSON-RPC 2.0 — every namespace is served at `POST /cdk-blocks/api`. (The typed client posts to `/cdk-blocks/api/<namespace>`, which works too; the namespace in the path must match the one in `method`.)

```bash
# "Is it alive?" check:
curl -X POST $(cat .cdk-blocks-sandbox/config.json | jq -r .apiUrl) \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.ping","params":[],"id":1}'
# → {"jsonrpc":"2.0","result":{"ok":true,"timestamp":...},"id":1}
```

### Request format

```json
{ "jsonrpc": "2.0", "method": "<exportName>.<methodName>", "params": [...args], "id": 1 }
```

- `<exportName>` — the **export variable name** from `cdk-blocks/index.ts` (e.g., `export const api = ...` → `api`; `export const authApi = ...` → `authApi`)
- `<methodName>` — the function name inside the namespace
- `params` — positional array of the function's arguments
- Errors return HTTP 200 with a JSON-RPC `error` object (not a non-2xx HTTP status)

### Examples

```bash
# api.createNote("Hello", "World")
curl -X POST http://localhost:3000/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.createNote","params":["Hello","World"],"id":1}'

# authApi.getAuthState()
curl -X POST http://localhost:3000/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.getAuthState","params":[],"id":1}'

# authApi.setAuthState (sign up)
curl -X POST http://localhost:3000/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.setAuthState","params":[{"action":"signUp","username":"alice@example.com","password":"Secret123!"}],"id":1}'
```

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 404 on `/api/...` or `/authApi/...` | Wrong URL — every call goes under `/cdk-blocks/api` | Use `POST /cdk-blocks/api` with method in the body |
| `-32600` `Invalid Request: the path addresses namespace "…" but the method is in namespace "…"` | The namespace after `/cdk-blocks/api/` differs from the one in `method` (names are case-sensitive) | Use the same export name in both, or post to the bare `/cdk-blocks/api` |
| `-32600` `Invalid Request: an RPC call goes to /cdk-blocks/api or /cdk-blocks/api/<namespace>, not a deeper path` | Extra path segments after the namespace | Post to `/cdk-blocks/api/<namespace>` exactly |
| HTTP 200 but `{"error":...}` in body | Normal JSON-RPC error response | Read `error.message` — not a routing problem |
| `API 'foo' not found` | Namespace doesn't match any export name | Check your `export const` names in `cdk-blocks/index.ts` |
| `config.json` not found | No dev server has started in this app | Run `npm run dev`, or set `BLOCKS_API_URL` to the API you mean to call |
| 404 on `/config.json` | Wrong path, the config is served from a dotted directory | Use `GET /.blocks-sandbox/config.json` |
| Config body is `{"_placeholder":true}` | Build-time stub in the frontend build output; the real config is uploaded at deploy | Nothing to fix pre-deploy. If a deployed origin serves it, re-run the deploy |
| HTTP 200 but `{"error":{"code":-32600}}` on a batch | JSON-RPC batching (a top-level JSON array body) is not supported | Send one call per request |

## TypeScript errors in `cdk-blocks/` from the frontend

The frontend imports the backend (`import { api } from 'cdk-blocks'`), so its `tsconfig` typechecks the backend unless the backend is a TypeScript project of its own, as in the Vite templates. [Keep Node types out of the frontend](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend) has the steps for other apps.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `TS2591: Cannot find name 'process'` (or `Buffer`) in `cdk-blocks/`; `TS2307` for a `node:` import | The frontend `tsconfig` typechecks the backend source, and its `types` (such as `["vite/client"]`) leaves out Node | Reference the backend's project from that `tsconfig` and typecheck with `tsc -b --force` ([steps](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend)). In Next.js, leave `types` unset instead |
| The same errors in `src/` | Browser code uses a Node global, which a Vite template's `tsconfig.app.json` leaves out on purpose | Move that code into `cdk-blocks/`, or read build-time values with `import.meta.env` |
| `TS6305: Output file '...' has not been built from source file '.../cdk-blocks/index.ts'` | `tsc` ran without `-b`, so nothing built the referenced backend | Run `npm run typecheck` (`tsc -b --force`) |
| `TS6307: File '...' is not listed within the file list of project '.../cdk-blocks/tsconfig.json'` | The backend imports a `.json` file, or a file outside `cdk-blocks/` | Add its folder to `include` in `cdk-blocks/tsconfig.json`, for example `"data/**/*.json"`. For code the browser imports too, see the guide's note on shared code |
| `TS2742: The inferred type of '...' cannot be named without a reference to '.pnpm/...'` (pnpm) | The backend's project writes declarations, and an inferred type comes from a package pnpm does not hoist | Annotate the export's type (for example `const blocksStack: BlocksStack = ...`), or set `node-linker=hoisted` in `.npmrc` |
| `tsc -b --noEmit` fails with `TS6310` | The referenced backend has to write its declarations | Drop `--noEmit` and set `"noEmit": true` in the frontend `tsconfig` |

## Server won't start

| Message | Cause | Fix |
|---------|-------|-----|
| `❌ a dev server of this app is already running on :3000 (pid …).` `Not starting a second one.` | Another dev server for this app is running (or still `starting`), on any port | Use the running server, or stop it with `npm run dev:stop` before starting another. For a nondefault port, pass the port shown in the message, for example `npm run dev:stop -- --port 4000`. |
| `❌ port 3000 is in use by …` | A process that is not this app's dev server holds the port (or the frontend port), so the dev server doesn't start | Run the `kill …` the message prints (or find the holder with `lsof -i :3000`), or choose another port with `npm run dev -- --port 4000` (use `--frontend-port` for the frontend port) |
| `⚠️  Port 3000 is still in use after N attempts to bind it.`, then `❌ port 3000 is still in use.` | Something took the port between the startup check and the bind, and kept it through the retries | As above: stop the process the message names, or choose another port with `--port` |

```bash
# Check if port is already in use:
lsof -i :3000

# Kill stale processes:
pkill -f "tsx watch"
```

## `Frontend server unavailable` (502)

The dev server listens on one port (3000 by default). It answers the API (`POST /cdk-blocks/api`), your `RawRoute`s and `/.blocks-sandbox/config.json` itself, and proxies every other request to the frontend dev server (Next.js or Vite) on the frontend port, 3100 by default (`package.json#blocks.dev.frontendPort`, or `--frontend-port`). The body `Frontend server unavailable` with status **502** means that proxy could not reach anything on the frontend port. The API is unaffected.

| Symptom | Cause | Fix |
|---------|-------|-----|
| Startup log `Frontend did not start: Frontend server on port 3100 did not start within 30000ms`, then `(API only — frontend unavailable)` | The frontend command failed or is still starting, or it listens on a different port | Read the frontend's error output above that line and fix it; the proxy reaches the frontend as soon as it listens on the frontend port |
| `Frontend dev server exited (…) and exceeded 5 restarts within 10s — leaving it down.` | The frontend crashes on start (a build or config error) | Fix the error printed above it, then restart `npm run dev` |
| Warning `the frontend command "…" does not contain the frontend port 3100` | A custom `blocks.dev.frontendCommand` starts the frontend on its own port, which `--frontend-port` does not change | Put the frontend port in the command, or remove `frontendCommand` so `npm run dev` detects Next.js or Vite and starts it on that port |

Without a frontend (`--no-frontend`, `"frontend": false`, or no `next` / `vite` dependency) there is no proxy: those requests get an empty 404 instead.

## Other dev-server responses

| Response | Cause | Fix |
|----------|-------|-----|
| 403 `Forbidden: the AWS CDK Blocks dev server only answers requests addressed to localhost, 127.0.0.1, [::1] or the host set in BLOCKS_DEV_HOST.` | The request's `Host` header names another host (the DNS-rebinding guard) | Open the app at `localhost`, or set `BLOCKS_DEV_HOST` to the host you use (see the `@aws-cdk-blocks/core` README, "Local Development") |
| 404 `The AWS CDK Blocks JSON-RPC API expects POST, not GET.` | An RPC path was requested with another method, for example by opening it in a browser | Call it with `POST` (see [RPC Wire Protocol](#rpc-wire-protocol)) |
| 403 `{"error":"Forbidden: cross-origin request rejected"}` | A `POST`, `PUT`, `PATCH` or `DELETE` whose `Origin` names another site | Call from a loopback origin or the host in `BLOCKS_DEV_HOST`; see the `@aws-cdk-blocks/core` README, "Local Development", for the allowed origins |
| 415 `Unsupported Media Type: the AWS CDK Blocks JSON-RPC API expects Content-Type: application/json` | A JSON-RPC call sent without `Content-Type: application/json` | Send that header (with `curl`, `-H 'Content-Type: application/json'`); the generated clients already do |

## Auth cookies not persisting

Session cookies are `HttpOnly; SameSite=Lax`, plus `Secure` over HTTPS. With `crossDomain: true` (frontend and API on different domains) they are `HttpOnly; Secure; SameSite=None; Partitioned` instead (`Partitioned` is dropped on localhost). In local dev, the dev server serves the app and API from one origin, so cookies work without extra setup. If testing with `curl`, you need to save and resend cookies:

```bash
# Sign in and save cookies
curl -c cookies.txt -X POST http://localhost:3000/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.setAuthState","params":[{"action":"signIn","username":"alice@example.com","password":"Secret123!"}],"id":1}'

# Use cookies for authenticated calls
curl -b cookies.txt -X POST http://localhost:3000/cdk-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.listNotes","params":[],"id":1}'
```
