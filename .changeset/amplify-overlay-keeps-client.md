---
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

fix: the Amplify overlay keeps its own `aws-blocks/client.js` under `blocks dev`

- create-blocks-app's Amplify overlay now writes `"generateClient": false` in `package.json#blocks.dev`, next to `"port": 3001` and `"frontend": false`. Without it, the dev server replaced the overlay's committed `client.js`, which reads the API URL from `amplify_outputs.json` and adds the Cognito token, with the generic client.
- `blocks migrate` adds the same `"generateClient": false` when it moves the Amplify overlay's generated `server.ts` to `blocks.dev`. Other templates are unchanged.
