---
"@aws-blocks/core": minor
---

Hardening for the local dev server (`npm run dev`, including sandbox mode, where it forwards API requests to the deployed sandbox API) only; deployed APIs are unchanged. A page on another site could send a `text/plain` `POST` to `http://localhost:3000/aws-blocks/api`, which the browser sends without a CORS preflight, and run an API method against your local data. The dev server now refuses such requests, before it runs them locally or forwards them to a sandbox:

- A `POST`, `PUT`, `PATCH` or `DELETE` request whose `Origin` names another site gets `403 Forbidden`, for JSON-RPC calls and RawRoutes alike. Loopback origins on any port (a frontend dev server such as `http://localhost:5173`), the dev server's own address and the host set in `BLOCKS_DEV_HOST` are still allowed, and so are requests with no `Origin` header (`curl`, server-side rendering, native clients).
- A JSON-RPC call must send `Content-Type: application/json` (parameters such as `; charset=utf-8` are fine), or it gets `415 Unsupported Media Type`. The AWS Blocks clients already send it; with `curl`, pass `-H 'Content-Type: application/json'`. RawRoutes keep accepting any content type.
