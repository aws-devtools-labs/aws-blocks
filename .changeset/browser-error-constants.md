---
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/blocks": patch
---

fix: error constants can be imported in frontend code

Frontend code imports a Building Block's error constants to match errors with `isBlocksError`, which resolves the
package's `browser` entry. Some of those imports failed the frontend build:

- `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors` were missing from the `browser` entries
  of `@aws-blocks/bb-app-setting`, `@aws-blocks/bb-email-client`, `@aws-blocks/bb-file-bucket`, and
  `@aws-blocks/bb-logger`. They are now exported.
- `CronJobErrors.ScheduleNotSupported` was `undefined` in the browser, so `isBlocksError(e, CronJobErrors.ScheduleNotSupported)`
  never matched. The `@aws-blocks/bb-cron-job` and `@aws-blocks/bb-dashboard` browser entries now re-export the
  server's constants instead of keeping their own copies.
- `@aws-blocks/bb-realtime` had no `browser` entry, so importing `RealtimeErrors` in frontend code pulled in the
  server build and failed to bundle. It now has one.

`@aws-blocks/blocks`: the conditional-export parity test now checks that every Building Block with error constants
has a `browser` entry that exports them with the same values, and that the entry bundles for the browser.
