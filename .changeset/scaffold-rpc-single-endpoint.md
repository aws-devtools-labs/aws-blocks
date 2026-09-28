---
"@aws-blocks/create-blocks-app": patch
---

Document the single RPC endpoint in the scaffolded `AGENTS.md` and the `react`, `default`, and `bare` template READMEs.

These files told agents not to curl the API but never gave the request shape, so agents that needed to verify a deployed app guessed per-namespace paths (`/aws-blocks/authApi`) and got 404s. They now state that every namespace shares `POST /aws-blocks/api` with the namespace in the JSON-RPC `method` field, show a curl example, and cover error handling and the session cookie. The guidance to prefer the typed client and `npm run test:e2e` is unchanged.
