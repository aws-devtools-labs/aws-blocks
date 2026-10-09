---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

`deploy()` in production mode no longer hangs after the deploy finishes. It used to load your backend's local development (mock) versions of the Building Blocks while generating the client, which started local runtimes (the local `Database` engine, `CronJob` schedules) that kept `npm run deploy` running, and kept logging `[CronJob:…] triggered at …`, after "✅ Deployment complete!". Deploy no longer loads local mocks. As a side effect, it no longer applies migrations to, or writes data into, your local `.bb-data/` database.
