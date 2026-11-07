---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

The `hasAuthError` example in the `@aws-blocks/core` README and JSDoc now submits the action with `submitAuthAction` from `@aws-blocks/blocks/ui` and imports `hasAuthError` from `@aws-blocks/blocks/client`. The old example called `authApi.setAuthState()` directly, which signs the user in but never notifies `onAuthChange` or `AuthenticatedContent`, so a custom form built from it stayed on the sign-in screen. The `installCookieJar` documentation from `@aws-blocks/blocks/utils` now shows up in editors, because it is attached to the function instead of an internal variable.

The `AGENTS.md` that `create-blocks-app` adds to new apps now says that `onAuthChange` fires for sign-ins and sign-outs made through `Authenticator` or `submitAuthAction`, lists `submitAuthAction` for custom auth forms, and warns that a direct `authApi.setAuthState()` call notifies nothing on the page.
