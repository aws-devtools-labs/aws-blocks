---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

docs: fill gaps found when building an app from the READMEs

- `@aws-blocks/bb-auth-basic`: a React example that mounts `Authenticator` and
  `AccountMenuBar` and renders signed-in content, and a note that `AuthBasic` has no
  user directory.
- `@aws-blocks/blocks`: explain where the frontend's `'aws-blocks'` import comes from,
  how to fail an API method with `ApiError`, and how to call methods that use
  `requireAuth` from Node tests (`installCookieJar()`). `TROUBLESHOOTING.md` now
  gives the correct default session-cookie attributes (`SameSite=Lax`).
