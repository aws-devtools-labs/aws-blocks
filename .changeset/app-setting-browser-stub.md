---
"@aws-blocks/bb-app-setting": patch
---

Make the AppSetting browser build fail loudly instead of silently. AppSetting is server-side only, but its browser stub previously omitted the `get`/`put` methods entirely, so client-side calls hit a cryptic `is not a function`. The stub now carries the full public shape and its data methods throw a named, catchable `AppSettingErrors.BrowserNotSupported` error with guidance to read the value on the server and return it to the client. The constructor stays a no-op so a shared backend module that instantiates AppSetting still imports in the browser. Also removes the `any` casts from the stub.
