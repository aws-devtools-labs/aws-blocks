# Task: Instrumented Health API

Build an instrumented health/status service in this **backend-only** AWS Blocks app. A `ping` endpoint does its work under full observability — it logs, emits a metric, and runs inside a trace segment — and a small status page shows the configured app name plus a button to ping the service and see the result.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md, then do all your edits in this workspace.

**This is the `backend` template: no frontend.**

## Requirements

1. **App name from a setting:** the application's display name comes from an app-setting block — set its initial value to **exactly `"Observability Service"`** — read on the server via the block's documented API (not a hard-coded string in the page) and rendered verbatim into `[data-testid=appname]`.
2. **A `ping` operation, exposed as the JSON-RPC method `api.ping`** (a method on an `api` namespace) that, every time it runs:
   - writes a log line via the logger block,
   - emits a metric via the metrics block (e.g. a `Ping` count),
   - runs its work inside its own tracer segment,
   - and returns exactly `{ "status": "ok" }` — **no extra fields** (no timestamp/uptime/etc.).
   A direct `POST /aws-blocks/api` with `{"jsonrpc":"2.0","method":"api.ping","params":[],"id":1}` must respond with `result.status === "ok"` and **no** `error` envelope. The response must be **JSON-RPC 2.0 compliant**: it echoes the request `id`, includes `"jsonrpc":"2.0"`, and is sent with `Content-Type: application/json`. An **unknown** method (e.g. `api.nope`) must return a JSON-RPC **error** envelope (a populated `error`, no `result`) — not an HTTP 5xx and not a bogus success. `ping` is **stateless and concurrency-safe**: many parallel calls each return `{ "status": "ok" }` (run the work inside its own tracer segment; do not depend on a single shared mutable "current segment").

   In addition to `ping`, expose **two more methods on the same `api` namespace**. Each also does its work inside its **own** tracer segment and writes a log line (only `ping` emits the `Ping` metric):
   - **`api.info`** — takes no arguments and returns **exactly** `{ "name": <string>, "uptimeMs": <number> }` and **nothing else**. `name` is the app-setting value (the same `"Observability Service"`, read on the server via the block's documented API — not hard-coded), and `uptimeMs` is the process uptime in **milliseconds** (a non-negative `number`). This is structured data, not a status string — no `status`/extra fields.
   - **`api.echo`** — takes a **single argument** and returns **exactly** `{ "echo": <that argument, unchanged> }` and **nothing else**. The value must round-trip with its **original type** (a number stays a number — do not stringify). If the argument is **missing** (the call supplies no params, or an empty params list), `echo` must **validate the input** and return a JSON-RPC **error** envelope (a populated `error`, no `result`) — it must **not** return a degenerate success like `{ "echo": null }`.

   A **malformed** request — for example a JSON **array / batch** body in place of a single request object — must come back as a JSON-RPC **error** envelope with **`error.code === -32600`** (Invalid Request) and **no** `result`; it must never crash the server (no HTTP 5xx).
3. **A status page served by the backend.** Since this template has no frontend, serve a minimal HTML page at `GET /status` using the core block that lets you register a raw HTTP route and write the response yourself (set `Content-Type: text/html`). The page must:
   - show the app name (read from the setting) in `[data-testid=appname]`,
   - have a `[data-testid=ping-btn]` button that calls your `ping` operation,
   - show the ping result text in `[data-testid=ping-status]` (must contain `ok` once the ping succeeds).
   Inline `<script>` is fine; it must run without throwing.
4. **Routing & content type:** the `/status` response must carry `Content-Type: text/html`, and any unmatched path (anything other than your routes) must return **404** — do not add a catch-all route.

All four blocks (setting, logger, metrics, tracer) must initialize cleanly when the server boots and when `ping` runs — the test fails on any browser error or server 5xx.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks on the served status page. Implement them exactly.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=appname]` | element on the page | Renders the app name read from the app-setting block (non-empty) |
| `[data-testid=ping-btn]` | `<button>` | Calls the instrumented `ping` operation |
| `[data-testid=ping-status]` | element on the page | Shows the ping result; must contain `ok` after a successful ping |

## Out of scope

- A real frontend framework / build step (serve plain HTML from a raw HTTP route — do **not** add React/Vite or new npm dependencies)
- Authentication, persistence, dashboards
- Real CloudWatch/X-Ray wiring (the local mocks for logger/metrics/tracer are enough)
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use, and no server 5xx.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
