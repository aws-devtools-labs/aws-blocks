---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): serve the react template from a single-origin front door

The `react` template was the only SPA template without a single-origin dev
front door: its `server.ts` ran the backend on `:3001` and `package.json`
used `concurrently` to start Vite on a separate `:3000` origin, with no
`/aws-blocks` proxy in `vite.config.ts`. As a result `/aws-blocks/*` — including
the server-initiated OIDC redirect routes (`/aws-blocks/auth/signin/*`) — was
not reachable from the SPA origin, breaking any browser-navigation auth flow
(e.g. OIDC) locally.

The template now matches every other SPA template: `startDevServer` runs Vite
via `frontendCommand` and exposes a unified front door on `:3000` (backend +
SPA same origin), and `npm run dev` runs the single dev server. This unblocks
OIDC / browser-navigation auth in the react template. Surfaced by the agent-bench.
