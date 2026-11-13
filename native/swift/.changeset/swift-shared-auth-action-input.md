---
"aws-blocks-swift": minor
---

One `AuthActionInput` serves every Auth block

`setAuthState(input:)` takes one shared `AuthActionInput` in every Auth namespace, with its variants nested inside it (`AuthActionInput.SignIn`), when the backend's spec names the type (`x-blocks-type-name`). Before, each namespace declared its own identical `SetAuthState.Input`, so a sign-in screen written for one Auth block couldn't send to another without glue code. Each namespace's old names (`AuthApi.SetAuthState.Input`, `AuthApi.SetAuthState.SignIn`) still compile, as deprecated typealiases.
