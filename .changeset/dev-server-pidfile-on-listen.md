---
"@aws-blocks/core": patch
---

`npm run dev:stop` and `npm run cleanup` now stop a dev server that was started at the same time as another one, such as `npm run dev &` followed at once by `npm run test:e2e`. Both starts passed the singleton check before either held the port, and the server that bound the port after the other one exited served without a pidfile, so `dev:stop` reported that nothing was running. The dev server now records itself again once it is listening.
