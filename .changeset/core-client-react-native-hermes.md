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
which bundlers leave alone and Hermes can parse. The config-file fallback
requires Node >= 20.16 / 22.3; on older Node it is skipped and resolution
continues with the existing `fetch('/.blocks-sandbox/config.json')` fallback.
