---
"@aws-blocks/hosting": patch
---

A server-rendered Astro app that configures `@astrojs/node` itself (`adapter: node({ mode: 'standalone' })` in `astro.config`) now deploys a server that starts. `Hosting` uploads the build output without the app's `node_modules`, and the build of such an app left its dependencies as imports, so the server function exited at start with `ERR_MODULE_NOT_FOUND` and every path answered 502.

The Astro adapter keeps your adapter and the rest of your config, and makes the build it runs bundle the app's dependencies into the server output (Vite's `ssr.noExternal: true`, for that build only: `astro dev` and your own `astro build` are unchanged). This also applies to a config without `output: 'server'` whose pages opt out of prerendering.

An app with any other adapter is built from its config as written, as before. A package listed in `vite.ssr.external` stays an import and isn't uploaded. A package that can't be bundled fails this build, also for a fully prerendered app that configures `@astrojs/node`; the `AstroBuildError` resolution now says so, and that a package only prerendered pages use can go in `vite.ssr.external`.

Synth now fails instead of deploying a server that can't start in two more cases:

- `AstroBuildConfigNotAppliedError`: the build exited 0 without using the config the Astro adapter passed with `--config`. `npm run build -- --config` reaches Astro when the `build` script ends with `astro build`; `npx astro build -- --config`, used when `package.json` has no `build` script, doesn't, because Astro ignores options after `--`. An app that configures `@astrojs/node` and sets `vite.ssr.noExternal: true` itself is exempt.
- `AstroNodeMiddlewareModeError`: `astro.config` sets `adapter: node({ mode: 'middleware' })`, whose server entry exports a handler and starts no server. Use `mode: 'standalone'`.
