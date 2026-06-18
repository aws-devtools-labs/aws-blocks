# Task: Instrumented Health API

Build an instrumented health/status service in this **backend-only** AWS Blocks app. A `ping` endpoint does its work under full observability — it logs, emits a metric, and runs inside a trace segment — and a small status page shows the configured app name plus a button to ping the service and see the result.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading README.md, then do all your edits in this workspace.

**This is the `backend` template: no frontend, and the dev server listens on port 3001** (the test reads `/tmp/dev.port` / `BLOCKS_URL`, so you don't hard-code it). The RPC endpoint is JSON-RPC 2.0 at `POST /aws-blocks/api`; unmatched paths return 404.

## Requirements

1. **App name from a setting:** the application's display name comes from an app-setting block (give it an initial value like `"Observability Service"`), read on the server with `.get()` — not a hard-coded string in the page.
2. **A `ping` operation** that, every time it runs:
   - writes a log line via the logger block,
   - emits a metric via the metrics block (e.g. a `Ping` count),
   - runs its work inside a tracer segment (`startSegment`),
   - and returns a small JSON result indicating success, e.g. `{ "status": "ok" }`.
   You may expose `ping` as an `ApiNamespace` method or as a `RawRoute` — your choice.
3. **A status page served by the backend.** Since this template has no frontend, serve a minimal HTML page at `GET /status` using a `RawRoute` (set `Content-Type: text/html` and `context.response.send(html)`). **A `RawRoute` rejects the root path `/` at construction (it throws and crashes the server on boot), so serve the page at a sub-path like `/status`.** The page must:
   - show the app name (read from the setting) in `[data-testid=appname]`,
   - have a `[data-testid=ping-btn]` button that calls your `ping` operation,
   - show the ping result text in `[data-testid=ping-status]` (must contain `ok` once the ping succeeds).
   Inline `<script>` is fine; it must run without throwing.

All four blocks (setting, logger, metrics, tracer) must initialize cleanly when the server boots and when `ping` runs — the test fails on any browser error or server 5xx.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md`. Read the ones for the app-setting, logger, metrics, and tracer blocks, plus the `RawRoute` docs in the core/blocks README, before wiring.

Sketch of the shape you're building (read the READMEs for exact options):

```ts
import { Scope, ApiNamespace, RawRoute, AppSetting, Logger, Metrics, Tracer } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const appName = new AppSetting(scope, 'appName', { value: 'Observability Service' });
const log = new Logger(scope, 'app');
const metrics = new Metrics(scope, 'app');
const tracer = new Tracer(scope, 'app');

// GET /status -> text/html status page (RawRoute handler is imperative: write
// context.response). RawRoute throws on the root path '/', so serve at '/status'.
new RawRoute(scope, 'status', { method: 'GET', path: '/status', handler: async (ctx) => {
  const name = await appName.get();
  ctx.response.headers.set('Content-Type', 'text/html');
  ctx.response.send(statusPageHtml(name)); // ready-to-use HTML is below
}});
```

### Ready-to-use status page

Drop this helper into your backend and call it from the `RawRoute` handler
(`ctx.response.send(statusPageHtml(name))`). It already wires the three required
`data-testid`s and a fetch to the ping API, so spend your turns on the
Logger / Metrics / Tracer / AppSetting instrumentation instead of hand-rolling
HTML. `name` is the value you read from the app-setting on the server.

```ts
function statusPageHtml(name: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Status</title></head>
  <body>
    <h1>Status</h1>
    <p>App: <span data-testid="appname">${name}</span></p>
    <button data-testid="ping-btn">Ping</button>
    <pre data-testid="ping-status"></pre>
    <script>
      document.querySelector('[data-testid=ping-btn]').addEventListener('click', async () => {
        const out = document.querySelector('[data-testid=ping-status]');
        try {
          // ping is exposed here as an ApiNamespace method 'api.ping' (JSON-RPC 2.0).
          // If you expose ping as a RawRoute instead, point this fetch at that path.
          const res = await fetch('/aws-blocks/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'api.ping', params: [], id: 1 }),
          });
          const body = await res.json();
          // ping-status must contain "ok" once the ping succeeds.
          out.textContent = body?.result?.status ?? JSON.stringify(body.result ?? body);
        } catch (e) {
          out.textContent = 'error: ' + String(e);
        }
      });
    </script>
  </body>
</html>`;
}
```

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend. Verify with `curl` against `http://localhost:3001/status` and your ping endpoint.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks on the served status page. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=appname]` | element on the page | Renders the app name read from the app-setting block (non-empty) |
| `[data-testid=ping-btn]` | `<button>` | Calls the instrumented `ping` operation |
| `[data-testid=ping-status]` | element on the page | Shows the ping result; must contain `ok` after a successful ping |

## Out of scope

- A real frontend framework / build step (serve plain HTML from a `RawRoute` — do **not** add React/Vite or new npm dependencies)
- Authentication, persistence, dashboards
- Real CloudWatch/X-Ray wiring (the local mocks for logger/metrics/tracer are enough)
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use, and no server 5xx.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
