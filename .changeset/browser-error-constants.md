---
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/blocks": patch
---

fix: error constants can be imported in frontend code

Frontend code imports a Building Block's error constants to match errors with `isBlocksError`, which resolves the
package's `browser` entry. Some of those imports failed the frontend build:

- `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors` were missing from the `browser` entries
  of `@aws-blocks/bb-app-setting`, `@aws-blocks/bb-email-client`, `@aws-blocks/bb-file-bucket`, and
  `@aws-blocks/bb-logger`. They are now exported.
- Any import from `@aws-blocks/bb-auth-basic` or `@aws-blocks/bb-auth-cognito`, including `AuthBasicErrors` and
  `AuthCognitoErrors`, failed with `No matching export ... for import "ApiNamespace"`. The browser stubs no longer
  depend on `ApiNamespace`; their server-only `createApi()` / `buildApi()` now throw if called in the browser.

`@aws-blocks/blocks`: the conditional-export parity test now checks that every Building Block's `browser` entry loads
and exports its error constants.
