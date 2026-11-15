---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): load the generated client only after the dev server is ready in template e2e tests

When `npm run test:e2e` started the dev server itself, the test imported `aws-blocks` before the server had regenerated `aws-blocks/client.js`. An API namespace you had exported since the client was last generated was then `undefined` in the test, and calls to it failed with `Cannot read properties of undefined` on that run. The test now waits for the server to answer before it imports the client, and no longer pauses for a fixed two seconds after starting the server. The Next.js template already created its client after the server was ready and is unchanged.
