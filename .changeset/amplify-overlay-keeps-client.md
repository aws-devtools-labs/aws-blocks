---
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

fix: the Amplify overlay keeps its own `aws-blocks/client.js` under `blocks dev`

- create-blocks-app's Amplify overlay now writes `"generateClient": false` in `package.json#blocks.dev`, next to `"port": 3001` and `"frontend": false`. Without it, the dev server replaced the overlay's committed `client.js`, which reads the API URL from `amplify_outputs.json` and adds the Cognito token, with the generic client.
- `blocks migrate` adds the same `"generateClient": false` when it moves the Amplify overlay's generated `server.ts` to `blocks.dev`. Other templates are unchanged.
- `blocks migrate` sets `blocks.dev` to `{"port": 3001, "frontend": false, "generateClient": false}` for an Amplify overlay from create-blocks-app 0.1.0 to 0.1.15 too, which has no `server.ts`, unless `blocks.dev` already exists. Migrate tells such an app by its generated `aws-blocks/scripts/generate-client.ts`.
