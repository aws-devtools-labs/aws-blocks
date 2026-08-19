---
"@aws-blocks/blocks": minor
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

Generate the local `aws-blocks` package's client entry point on fresh checkouts, under the correct export conditions.

The templates declare `./client.js` as the package's `browser`/`import` entry and gitignore it as generated, so a scaffold built on any machine other than the one that scaffolded it failed to resolve the package, and `cdk synth` failed with it (the Hosting block builds the frontend during synthesis).

`@aws-blocks/blocks` gains a `blocks-generate-client` bin (mirroring `blocks-generate-spec` and `blocks-vendorize`) that spawns the core generator worker with `--conditions=aws-runtime`, so the emitted client imports `aws-middleware` rather than `mock-middleware` regardless of how the hook is invoked. `@aws-blocks/core` exports the existing `generate-client-worker` subpath so the bin can resolve it. The templates wire `"prebuild": "blocks-generate-client"` (including `backend`, where the hook is dormant until a `build` script exists) and gitignore `.hosting/`, the Vite output written during synthesis.
