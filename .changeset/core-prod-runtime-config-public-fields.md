---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

docs(core): document what a deployed `/.cdk-blocks-sandbox/config.json` holds, and why it is served in production

Every Hosting deploy serves `/.cdk-blocks-sandbox/config.json`, production included. The browser client needs it to find the API, and `--wait-live` polls it for the build id. The `@aws-blocks/core` README now lists exactly what it holds: `apiUrl` (the same-origin `/aws-blocks/api`, or the absolute URL a `frontDoor: 'none'` page calls), `__blocksBuildId`, and your `backendConfig`. It never holds the account, the stack name or an ARN. New tests read the body each deploy uploads and fail if anything else appears in it.
