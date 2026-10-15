---
"@aws-blocks/create-blocks-app": minor
---

Templates no longer set `BLOCKS_SANDBOX` or pass `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to the auth Building Block. `npm run sandbox` serves the app through the local dev server, which proxies to API Gateway, so the browser talks to `localhost` only and the default `SameSite=Lax` session cookie is correct. Set `crossDomain: true` yourself only when a frontend on a different registrable domain calls the API directly. The Amplify template passes its Cognito settings with `registerConfig` instead of `handler.addEnvironment`.

Apps generated from an earlier template can delete the `if (sandboxMode) { blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true') }` block and the `crossDomain` line when upgrading `@aws-blocks/blocks`, since `blocksStack.handler` is removed.
