---
'@aws-blocks/core': minor
'@aws-blocks/bb-async-job': patch
'@aws-blocks/bb-cron-job': patch
'@aws-blocks/bb-realtime': patch
'@aws-blocks/bb-app-setting': patch
'@aws-blocks/bb-dashboard': patch
---

Two Building Blocks that would handle the same Lambda event now fail `cdk synth`, instead of deploying and then failing every request on cold start. This covers two `AsyncJob`s whose queue names collide, and two `CronJob`s or `Realtime` blocks that end up with the same scope-qualified id (for example `x-y`/`z` and `x`/`y-z`). The error names the event key and both blocks.

`registerConfig()` now also fails synth when another construct has already registered the same config key for the same backend with a different value, naming the key and both constructs; before, the second value silently replaced the first and both blocks read the same resource at runtime. Config keys built from a block id fold case and map every non-alphanumeric character to `_`, so ids such as `orders-a` and `orders_a` (or `Orders` and `orders`) collided this way: rename one of the blocks. Registering a key again from the same construct, or with the same value, is unaffected. Keys shared by design keep their last-one-wins behaviour: `Hosting`'s `BLOCKS_PUBLIC_ORIGIN` / `CORS_HOSTING_ORIGINS`, the dashboard URL, and `AppSetting`'s `BLOCKS_SSM_PARAM_*` key.
