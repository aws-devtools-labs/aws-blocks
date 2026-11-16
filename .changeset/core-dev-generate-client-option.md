---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): let an app keep its own `aws-blocks/client.js` under the dev server

At every start in local mode, the dev server regenerated `aws-blocks/client.js` from the backend. In the Amplify overlay that replaced the hand-written client, which reads the API URL from `amplify_outputs.json` and adds the Cognito token, with the generic one. The client is committed, so the next deploy could ship it without auth.

Set `"generateClient": false` in `package.json#blocks.dev` (or pass `startDevServer({ generateClient: false })`) to keep the existing `client.js`. When the option isn't passed, the dev server reads the setting from the app's `package.json`. The default is unchanged: the client is regenerated.
