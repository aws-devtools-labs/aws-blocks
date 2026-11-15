# Troubleshooting

## Finding the API URL

The API URL is always in `.blocks-sandbox/config.json`:

```bash
cat .blocks-sandbox/config.json
# Local dev:  {"apiUrl":"http://localhost:3000/aws-blocks/api","environment":"local"}
# Sandbox:    {"apiUrl":"https://<id>.execute-api.<region>.amazonaws.com/prod/aws-blocks/api","environment":"sandbox"}
# Production: {"apiUrl":"https://<id>.execute-api.<region>.amazonaws.com/prod/aws-blocks/api","environment":"production"}
```

In production with Hosting, browser requests go through CloudFront (same-origin at `/aws-blocks/api`), but `config.json` still contains the underlying API Gateway URL.

### Over HTTP the config lives at `/.blocks-sandbox/config.json`

The browser client fetches its config from the **dotted** path `/.blocks-sandbox/config.json`. `/config.json` is not a route in local dev or in production, so a 404 there tells you nothing:

```bash
curl http://localhost:3000/.blocks-sandbox/config.json
# → {"apiUrl":"http://localhost:3000/aws-blocks/api","environment":"local"}

curl -o /dev/null -w '%{http_code}\n' http://localhost:3000/config.json
# → 404   (expected, this path never existed)
```

`{"_placeholder":true}` is also expected in one place: the Hosting construct writes that stub into the frontend build output during CDK synth so the static route exists while the real `apiUrl` is still an unresolved CloudFormation token, and the deploy uploads the resolved config over it. Seeing it in `dist/.blocks-sandbox/config.json`, or on the origin between synth and deploy, is not a broken config. A **deployed** origin still serving the stub after a successful deploy is a real bug.

## RPC Wire Protocol

The typed client (`import { api } from 'aws-blocks'`) handles all RPC automatically. This section is for low-level troubleshooting only.

**Format:** JSON-RPC 2.0 — every namespace is served at `POST /aws-blocks/api`. (The typed client posts to `/aws-blocks/api/<namespace>`, which works too; the namespace in the path must match the one in `method`.)

```bash
# "Is it alive?" check:
curl -X POST $(cat .blocks-sandbox/config.json | jq -r .apiUrl) \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.ping","params":[],"id":1}'
# → {"jsonrpc":"2.0","result":{"ok":true,"timestamp":...},"id":1}
```

### Request format

```json
{ "jsonrpc": "2.0", "method": "<exportName>.<methodName>", "params": [...args], "id": 1 }
```

- `<exportName>` — the **export variable name** from `aws-blocks/index.ts` (e.g., `export const api = ...` → `api`; `export const authApi = ...` → `authApi`)
- `<methodName>` — the function name inside the namespace
- `params` — positional array of the function's arguments
- Errors return HTTP 200 with a JSON-RPC `error` object (not a non-2xx HTTP status)

### Examples

```bash
# api.createNote("Hello", "World")
curl -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.createNote","params":["Hello","World"],"id":1}'

# authApi.getAuthState()
curl -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.getAuthState","params":[],"id":1}'

# authApi.setAuthState (sign up)
curl -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.setAuthState","params":[{"action":"signUp","username":"alice@example.com","password":"Secret123!"}],"id":1}'
```

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 404 on `/api/...` or `/authApi/...` | Wrong URL — every call goes under `/aws-blocks/api` | Use `POST /aws-blocks/api` with method in the body |
| `-32600` `Invalid Request: the path addresses namespace "…" but the method is in namespace "…"` | The namespace after `/aws-blocks/api/` differs from the one in `method` (names are case-sensitive) | Use the same export name in both, or post to the bare `/aws-blocks/api` |
| `-32600` `Invalid Request: an RPC call goes to /aws-blocks/api or /aws-blocks/api/<namespace>, not a deeper path` | Extra path segments after the namespace | Post to `/aws-blocks/api/<namespace>` exactly |
| HTTP 200 but `{"error":...}` in body | Normal JSON-RPC error response | Read `error.message` — not a routing problem |
| `API 'foo' not found` | Namespace doesn't match any export name | Check your `export const` names in `aws-blocks/index.ts` |
| `config.json` not found | Server not started or not deployed yet | Run `npm run dev` or `npm run sandbox` first |
| 404 on `/config.json` | Wrong path, the config is served from a dotted directory | Use `GET /.blocks-sandbox/config.json` |
| Config body is `{"_placeholder":true}` | Build-time stub in the frontend build output; the real config is uploaded at deploy | Nothing to fix pre-deploy. If a deployed origin serves it, re-run the deploy |
| HTTP 200 but `{"error":{"code":-32600}}` on a batch | JSON-RPC batching (a top-level JSON array body) is not supported | Send one call per request |

## TypeScript errors in `aws-blocks/` from the frontend

The frontend imports the backend (`import { api } from 'aws-blocks'`), so its `tsconfig` typechecks the backend unless the backend is a TypeScript project of its own, as in the Vite templates. [Keep Node types out of the frontend](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend) has the steps for other apps.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `TS2591: Cannot find name 'process'` (or `Buffer`) in `aws-blocks/`; `TS2307` for a `node:` import | The frontend `tsconfig` typechecks the backend source, and its `types` (such as `["vite/client"]`) leaves out Node | Reference the backend's project from that `tsconfig` and typecheck with `tsc -b --force` ([steps](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend)). In Next.js, leave `types` unset instead |
| The same errors in `src/` | Browser code uses a Node global, which a Vite template's `tsconfig.app.json` leaves out on purpose | Move that code into `aws-blocks/`, or read build-time values with `import.meta.env` |
| `TS6305: Output file '...' has not been built from source file '.../aws-blocks/index.ts'` | `tsc` ran without `-b`, so nothing built the referenced backend | Run `npm run typecheck` (`tsc -b --force`) |
| `TS6307: File '...' is not listed within the file list of project '.../aws-blocks/tsconfig.json'` | The backend imports a `.json` file, or a file outside `aws-blocks/` | Add its folder to `include` in `aws-blocks/tsconfig.json`, for example `"data/**/*.json"`. For code the browser imports too, see the guide's note on shared code |
| `TS2742: The inferred type of '...' cannot be named without a reference to '.pnpm/...'` (pnpm) | The backend's project writes declarations, and an inferred type comes from a package pnpm does not hoist | Annotate the export's type (for example `const blocksStack: BlocksStack = ...`), or set `node-linker=hoisted` in `.npmrc` |
| `tsc -b --noEmit` fails with `TS6310` | The referenced backend has to write its declarations | Drop `--noEmit` and set `"noEmit": true` in the frontend `tsconfig` |

## Server won't start

```bash
# Check if port is already in use:
lsof -i :3000

# Kill stale processes:
pkill -f "tsx watch"
```

## `502 Frontend server unavailable` in local dev

`npm run dev` serves the app on port 3000 (`blocks.dev.port`) and passes page requests on to the frontend's own dev server (Vite or Next.js), which listens on `blocks.dev.frontendPort` (default 3100). When nothing answers on that port, the page request gets HTTP 502 with the body `Frontend server unavailable`. API calls to `/aws-blocks/api` keep working, so the backend is not the problem. The dev server's output says which case it is:

| What the dev server printed | Cause | Fix |
|---|---|---|
| Nothing yet; the first page load came right after `npm run dev` | The frontend is still starting | Wait for the `➜  http://localhost:3000/` line, then reload |
| `Frontend did not start: ...` and `(API only — frontend unavailable)` | The frontend did not listen on its port within about 30 seconds: it failed to start (its errors are printed above this line), or port 3100 is held by a process the dev server could not stop (at startup it stops a leftover listener on the port and says so when it cannot) | Fix the error the frontend printed; for a busy port, stop the process holding it (`lsof -i :3100`) or set another port with `"blocks": { "dev": { "frontendPort": 3200 } }` in `package.json`; then restart `npm run dev` |
| `Frontend dev server exited (...); restarting in ...ms` | The frontend crashed; the dev server restarts it | Usually nothing: reload once it is back. If it keeps crashing, fix the error printed before the exit |
| `... exceeded 5 restarts within 10s — leaving it down` | The frontend crashed more than 5 times in 10 seconds | Fix the error printed above, then restart `npm run dev` |
| A warning that the frontend command does not contain the frontend port | A custom `blocks.dev.frontendCommand` starts the frontend on another port than the one the dev server proxies to | Put the port in the command, or remove `frontendCommand` so the dev server detects Vite or Next.js and starts it on `frontendPort` |

## Auth cookies not persisting

Session cookies are `HttpOnly; SameSite=Lax`, plus `Secure` over HTTPS. With `crossDomain: true` (frontend and API on different domains) they are `HttpOnly; Secure; SameSite=None; Partitioned` instead (`Partitioned` is dropped on localhost). In local dev, the dev server serves the app and API from one origin, so cookies work without extra setup. If testing with `curl`, you need to save and resend cookies:

```bash
# Sign in and save cookies
curl -c cookies.txt -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"authApi.setAuthState","params":[{"action":"signIn","username":"alice@example.com","password":"Secret123!"}],"id":1}'

# Use cookies for authenticated calls
curl -b cookies.txt -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.listNotes","params":[],"id":1}'
```
