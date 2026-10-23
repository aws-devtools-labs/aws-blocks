---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

`npm run sandbox` telemetry now reports which Building Blocks your app uses (when telemetry is enabled); before, it always reported none. The sandbox now generates the deployed client before deploying, as `npm run deploy` does, so `aws-blocks/client.js` is ready before the deploy starts and an error in the backend surfaces before the deploy rather than after it. The deploy itself is unchanged.
