---
"@aws-blocks/blocks": minor
---

feat(blocks): `cdk-blocks dev` starts the Nuxt and Astro dev servers

Without a `frontendCommand`, `cdk-blocks dev` and `cdk-blocks sandbox` now detect `nuxt` and `astro` in the app's dependencies, as they detect `next` and `vite`, and start `npx nuxt dev --port <frontendPort>` or `npx astro dev --port <frontendPort>`. Before, a Nuxt or Astro app without `blocks.dev.frontendCommand` got the backend only, and every page answered 404.

The first match wins, in the order `next`, `nuxt`, `astro`, `vite`, so a Nuxt or Astro app that also lists `vite` now runs its own dev server instead of `npx vite`. A SvelteKit app lists `vite`, and is started with it as before. To keep a Nuxt or Astro app backend-only, set `"blocks": { "dev": { "frontend": false } }` in `package.json` or pass `--no-frontend`; a `frontendCommand` you set still wins over detection.

`nuxt dev` and `astro dev` have no equivalent of Vite's `--strictPort`: when `frontendPort` is taken they move to another port, which they print, and the app answers 502 until the port is free or you choose another with `--frontend-port`.
