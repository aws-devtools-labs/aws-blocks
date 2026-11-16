---
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": patch
---

feat(blocks): `cdk-blocks dev` starts the Nuxt and Astro dev servers

Without a `frontendCommand`, `cdk-blocks dev` and `cdk-blocks sandbox` now detect `nuxt` and `astro` in the app's dependencies, as they detect `next` and `vite`, and start `npx nuxt dev --host 127.0.0.1 --port <frontendPort> --strictPort` or `npx astro dev --host 127.0.0.1 --port <frontendPort>`. Before, a Nuxt or Astro app without `blocks.dev.frontendCommand` got the backend only, and every page answered 404.

The first match wins, in the order `next`, `nuxt`, `astro`, `vite`, so a Nuxt or Astro app that also lists `vite` now runs its own dev server instead of `npx vite`. A SvelteKit app lists `vite`, and is started with it as before. To keep a Nuxt or Astro app backend-only, set `"blocks": { "dev": { "frontend": false } }` in `package.json` or pass `--no-frontend`; a `frontendCommand` you set still wins over detection.

Upgrade note: an app that runs `cdk-blocks dev` for the backend only and starts `nuxt dev` or `astro dev` itself (for example through `concurrently`) now gets a second frontend dev server for the same project on `frontendPort`. Two Nuxt dev servers in one project write the same `.nuxt` directory. Remove the app's own frontend process, or set `"blocks": { "dev": { "frontend": false } }`.

Every detected command, `vite` included (now `npx vite --host 127.0.0.1 --port <frontendPort> --strictPort`), binds `127.0.0.1` explicitly, so a `HOST` variable in the environment or a `host` setting in the framework's config does not expose the frontend dev server to the network. Vite and Nuxt 4 exit when `frontendPort` is taken. Nuxt 3 and Astro move to another port, which they print, and the app answers 502 until the port is free or you choose another with `--frontend-port`.

`cdk-blocks migrate` still leaves `frontendCommand` out of `blocks.dev` for a generated `server.ts` whose dev server `cdk-blocks dev` detects from the app's dependencies, although the detected `vite` command now adds `--host 127.0.0.1`.
