---
'@aws-blocks/create-blocks-app': patch
---

The `auth` template's `api` namespace is now defined with `auth.protect`: its signed-in methods run only after the session check, with the signed-in user, and `ping` and `getLastCode` are its `public` methods. The frontend and the scaffolded e2e tests call it as before.
