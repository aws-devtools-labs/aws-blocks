---
"@aws-blocks/create-blocks-app": patch
---

Front-load the scaffolded `AGENTS.md` with the framework model an agent needs before building.

The scaffolded `AGENTS.md` previously pointed coding agents at the block docs folder and let them rediscover the framework wiring on every project. It now states the load-bearing facts inline: the backend-defines / frontend-imports-the-same-name client model (and the "don't import `index.ts` directly" pitfall), method namespacing (`namespace.method`), auth via `requireAuth` + the `@aws-blocks/blocks/ui` components, that the deployed frontend discovers the API through `/.blocks-sandbox/config.json` (no hardcoded URL), and a minimal end-to-end example. The full docs pointer is retained for depth. Reduces the doc-reading and wiring-discovery an agent does to get a first API call working.
