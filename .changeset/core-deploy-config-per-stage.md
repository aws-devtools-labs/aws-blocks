---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

fix(core,blocks,create-blocks-app): a deploy no longer points the local dev loop at AWS

Every deploy rewrote `.blocks-sandbox/config.json` with its AWS `apiUrl`. The Node.js client reads that file, while the browser gets its config from the running dev server, so after a `blocks deploy` or `blocks sandbox deploy` with `npm run dev` running, `npm run test:e2e` signed up users and wrote items in the deployed stack, production included, and a Next.js Server Component rendered from the production Lambda, with nothing pointing at it.

- `deploy()` records its API URL in `.blocks-sandbox/config.production.json`, and a sandbox deploy in `.blocks-sandbox/config.sandbox.json`, both `{apiUrl, environment}`. Neither writes `config.json` any more: only a dev server does, with its own local URL.
- The dev server sets `BLOCKS_API_URL` to its own front door on the frontend command it runs (Vite, `next dev`), so server-side frontend code calls the local server. In sandbox mode that is the local front door, which proxies to the sandbox.
- The template e2e tests set `BLOCKS_API_URL` to the dev server on `blocks.dev.port` before they load the client. Set `TEST_URL` to the URL a deployed app's API is under to run them against it; they then start no dev server.
- `blocks generate spec` takes the spec's `servers` entry from the dev server's `config.json`, or from `config.<stage>.json` when `BLOCKS_SPEC_STAGE` is `sandbox` or `production`.
- `blocks destroy` and `blocks sandbox destroy` also remove the destroyed stage's `config.<stage>.json`.

Scripts that read a deployed URL from `config.json` after a deploy should read `config.sandbox.json` or `config.production.json`, or `blocks sandbox deploy --query apiUrl`.
