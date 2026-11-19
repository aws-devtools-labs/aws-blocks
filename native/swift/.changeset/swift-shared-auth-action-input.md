---
"aws-blocks-swift": minor
---

One `AuthActionInput` serves every Auth block

`setAuthState(input:)` takes one shared `AuthActionInput` in every Auth namespace, with its variants nested inside it (`AuthActionInput.SignIn`), when the backend's spec names the type (`x-blocks-type-name`). Before, each namespace declared its own identical `SetAuthState.Input`, so a sign-in screen written for one Auth block couldn't send to another without glue code. Each namespace's old names (`AuthApi.SetAuthState.Input`, `AuthApi.SetAuthState.SignIn`) still compile, as deprecated typealiases. A union with an arm that isn't a discriminated object keeps its per-operation type, since that arm's case is named after the union and couldn't keep its old name. When parameters of different shapes are given one name, the shape of the one whose `<namespace>.<method>` and parameter sort first takes it, whatever their order in the spec, and the others keep their per-operation types.
