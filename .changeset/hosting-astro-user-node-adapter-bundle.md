---
"@aws-blocks/hosting": patch
---

A server-rendered Astro app that configures `@astrojs/node` itself (`adapter: node({ mode: 'standalone' })` in `astro.config`) now deploys a server that starts. `Hosting` uploads the build output without the app's `node_modules`, and the build of such an app left its dependencies as imports, so the server function exited at start with `ERR_MODULE_NOT_FOUND` and every path answered 502.

The Astro adapter keeps your adapter and the rest of your config, and makes the build it runs bundle the app's dependencies into the server output (Vite's `ssr.noExternal: true`, for that build only: `astro dev` and your own `astro build` are unchanged). This also applies to a config without `output: 'server'` whose pages opt out of prerendering.

An app with any other adapter is built from its config as written, as before. A package listed in `vite.ssr.external` stays an import and isn't uploaded.
