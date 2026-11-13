---
'@aws-blocks/core': patch
---

fix(client): `@aws-blocks/core/client` now bundles for React Native (Hermes)

The client's Node-only `.blocks-sandbox/config.json` fallback loaded `fs` with
`await import(/* webpackIgnore: true */ 'node:fs')`. Expo's Metro honors the
`webpackIgnore` comment and leaves a native dynamic `import()` in the bundle,
which Hermes cannot compile, so every Expo / React Native build that imported a
generated Blocks client failed at the `hermesc` step — even though that branch
never runs outside Node. The fallback now uses `process.getBuiltinModule('node:fs')`,
which bundlers leave alone and Hermes can parse. Reading the config file now
requires Node.js 22.3 or later. On Node.js 22.0 to 22.2 the file is not read:
set `BLOCKS_API_URL`, or upgrade Node.js. The "API URL not configured" error
names this requirement when it applies.
