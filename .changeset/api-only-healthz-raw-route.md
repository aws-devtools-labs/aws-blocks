---
'@aws-blocks/create-blocks-app': patch
---

The `api-only` template now ships a public `GET /healthz` `RawRoute` that answers load balancers and uptime monitors with a plain, uncached JSON response, since those probes can't send JSON-RPC. Its e2e tests call the route over HTTP, so the template suite now covers `RawRoute` too.
