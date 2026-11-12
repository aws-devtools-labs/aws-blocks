---
"@aws-blocks/create-blocks-app": patch
---

Scaffolded apps no longer describe the removed `AuthBasic` block: the generated `AGENTS.md` said that `AuthBasic` without `codeDelivery` signs the user in at sign-up, and now says that every sign-up confirms its email with a code and `codeDelivery` only receives the code locally. The templates no longer use `any`: the React template infers its `User` type from the backend's `authApi` and types its realtime subscription, the demo template exposes its page handlers with `Object.assign(window, …)` and reads caught errors through `isBlocksError` and `Error`, and the Amplify overlay types the backend it receives. A new test fails when a template or resource names a removed auth block or uses `: any` / `as any`.
