---
"@aws-blocks/blocks": patch
"@aws-blocks/core": patch
---

feat(blocks): `blocks sandbox preview` deploys the preview sandbox

- `blocks sandbox preview` deploys the sandbox once with the app hosted in preview shape, prints the preview URL and exits, as `npm run sandbox:preview` does. With `--output json` or `--query url` it prints the deploy result. `blocks sandbox --preview` and `blocks sandbox:preview` run it, for the npm-script spellings.
- `startSandbox` takes `previewInvocation`, the command that the warning of a plain deploy over a hosted preview names. Default: `npm run sandbox:preview`. The recorded deploy result's `url` is the URL the sandbox prints.
