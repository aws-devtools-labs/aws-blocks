---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): with `--host <address>`, the dev server's URLs and CORS use that address instead of localhost

When the dev server bound one specific address (`cdk-blocks dev --host 10.0.0.5`, or `BLOCKS_DEV_HOST`), it still printed `http://localhost:<port>`, wrote `apiUrl: http://localhost:<port>/aws-blocks/api` to `.blocks-sandbox/config.json`, and pointed the realtime WebSocket URL at localhost. A server bound to `10.0.0.5` isn't reachable at any of those. Its CORS fallback was also a hard-coded `http://localhost:3000`, whatever the port.

- The banner, `config.json` `apiUrl` and the realtime URL now use the bound host. Loopback and all-interfaces binds (`0.0.0.0`) keep using `localhost`.
- CORS still reflects localhost origins. It now also reflects origins on the specific host the server binds, on any port. The fallback is the server's own origin, `http://<host>:<port>`.
- New exports: `devUrlHost(host)`. `resolveDevCorsOrigin`, `buildDevCorsHeaders` and `buildBlocksConfig` take the bound host (and port) as an optional last argument.
