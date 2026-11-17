---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth": patch
"@aws-blocks/bb-compute": patch
"@aws-blocks/bb-container-compute": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-database": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-secret": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/blocks": patch
"@aws-blocks/data-common": patch
"@aws-blocks/hosting": patch
"@aws-blocks/pipeline": patch
---

Declare `sideEffects` in `package.json` so bundlers can leave out the modules an app does not use

Each package now tells bundlers (esbuild, Rollup, webpack, Vite) which of its modules to keep even when nothing is imported from them. Any other module can be left out of a bundle that does not use it.

- Every Building Block lists its local (`default`) entry, which checks on import that it is not running in a deployed environment.
- `@aws-blocks/bb-realtime` and `@aws-blocks/bb-file-bucket` also list their client middleware modules. The generated `client.js` imports them only so that they register themselves.
- `@aws-blocks/bb-agent` also lists its AgentCore entry (`@aws-blocks/bb-agent/agentcore`).
- `@aws-blocks/data-common`, `@aws-blocks/hosting` and `@aws-blocks/pipeline` declare `"sideEffects": false`.
- `@aws-blocks/blocks` adds a test that fails when a client middleware module would be left out of a browser bundle. The package itself stays without a `sideEffects` declaration.

No API or runtime behavior changes. A bundle that uses only part of a package can get smaller.
