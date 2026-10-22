---
"@aws-blocks/core": minor
"@aws-blocks/create-blocks-app": minor
---

feat(core,create-blocks-app): `npm run sandbox:preview` deploys a hosted preview sandbox

`startSandbox({ preview: true })` now synthesizes and deploys with `--context previewMode=true` next to `sandboxMode=true` (the key is exported as `PREVIEW_MODE_CONTEXT`), prints the hosted site URL, and hotswaps re-deploys. The app decides what the signal does.

The `create-blocks-app` templates that include hosting (`default`, `bare`, `react`, `nextjs`, `auth-cognito`, `demo`) add a `sandbox:preview` script (`tsx aws-blocks/scripts/sandbox.ts --preview`) and add `Hosting` with `HostingPresets.preview` to a preview sandbox. A plain `npm run sandbox` stays backend-only, and `npm run deploy` deploys the full shape. Tear a preview sandbox down with `npm run sandbox:destroy`.
