---
"@aws-blocks/core": patch
---

Hardening for the local dev server: it now answers `403 Forbidden` to any request whose `Host` header isn't `localhost`, `127.0.0.1`, `[::1]` or the host configured with `BLOCKS_DEV_HOST` / `startDevServer({ host })`, before the request is dispatched or proxied. This blocks DNS rebinding, where a page on another site re-points its own DNS name at `127.0.0.1` to call the local API. With a wildcard bind (`0.0.0.0` / `::`), requests by IP address are still served; to open the app by a hostname, set `BLOCKS_DEV_HOST` to that hostname. The local `/aws-blocks/settings` shortcut also checks each request now, and opens `.bb-data/settings.json` only for a request from the address bar or the app itself; a request another site triggers gets `403`.
