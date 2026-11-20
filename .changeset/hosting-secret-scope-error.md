---
"@aws-blocks/hosting": patch
---

`getSecret()` and `getConfig()` now explain why a value can't be read when the calling function has no store locator. The error names the missing locator, says that `secret()` / `config()` in Hosting props reach only Hosting's deployed SSR/server functions (not the Blocks API backend or a sandbox), and points to `.env.local` for local dev and to the `Secret` / `AppSetting` blocks for API code. Before, it told you to add the reference to Hosting props even when it was already there.

The README's "Read" section now says the same thing about which functions can read the stored value.
