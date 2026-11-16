---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): a dev server bound to all interfaces (`--host 0.0.0.0` or `::`) gives a browser the API at the address it opened the app on

A browser that opened the app at the machine's address (`http://10.0.0.5:3000`) got `apiUrl: http://localhost:3000/aws-blocks/api` from `/.blocks-sandbox/config.json`, so it called localhost: another origin on the same machine, and nothing at all from another machine. CORS answered such a page with `Access-Control-Allow-Origin: http://localhost:3000`.

- With an all-interfaces bind, the dev server now answers `/.blocks-sandbox/config.json` with the same-origin `apiUrl` `/aws-blocks/api`, which the client resolves against the page. The `.blocks-sandbox/config.json` file keeps the absolute localhost URL, for Node.js readers.
- CORS also reflects the Origin of a same-origin request, the one that equals `http://<Host header>`.
- New export: `buildServedBlocksConfig(port, isSandbox, host)`. `resolveDevCorsOrigin` and `buildDevCorsHeaders` take the request's Host header as an optional last argument.
