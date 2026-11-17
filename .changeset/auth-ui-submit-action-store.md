---
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": minor
---

feat(auth-common): `subscribeAuthState`, `getAuthStateSnapshot` and a shared auth-state store behind `submitAuthAction`; sign-in/out reaches every component and tab exactly once

Custom sign-in forms now stay in sync with the rest of the page. Calling `authApi.setAuthState(...)` directly changes the session but notifies nothing on the client, so `onAuthChange`, `AuthenticatedContent` and `AccountMenuBar` kept showing the old state until a reload — most visibly after a custom sign-out.

- `submitAuthAction(authApi, input)` (new in this release, see its own entry) now also writes the shared store and notifies everything that renders auth: a sign-in or sign-out reaches every `onAuthChange` subscriber in this tab and in other tabs, exactly once. It resolves to the same `AuthState` `setAuthState` returns; a `retriable` result (wrong password, bad code) changes nothing, so you can keep the current form and show the error. Outside a browser it is just the RPC. Use it for sign-in and sign-out alike.
- `subscribeAuthState(authApi, listener)` and `getAuthStateSnapshot(authApi)` expose the shared auth state as a store, including mid-flow steps such as a confirm-code challenge, ready for React's `useSyncExternalStore`:

  ```ts
  useSyncExternalStore((cb) => subscribeAuthState(authApi, cb), () => getAuthStateSnapshot(authApi), () => null);
  ```

- The `Authenticator` and `AccountMenuBar` now submit through `submitAuthAction`. Mid-flow challenge steps no longer broadcast a spurious signed-out `null` to `onAuthChange` subscribers, and a sign-in or sign-out in another tab triggers one `getAuthState()` refetch however many `Authenticator`s are mounted. A failed automatic sign-in after sign-up confirmation now shows its error instead of leaving the Continue step on screen, and two mounted `Authenticator`s no longer both redeem it.
- `AccountMenuBar`'s Sign Out follows a `signOut` action that carries a `url` (a federated session that must also end at the identity provider) as a form submit, as the `Authenticator` already does.

`subscribeAuthState` and `getAuthStateSnapshot` are exported, alongside `submitAuthAction`, from `@aws-blocks/blocks/ui` and `@aws-blocks/auth-common/ui`. `data-testid` hooks and action and field names are unchanged.

The cross-tab broadcast gains one optional field, so two auth APIs on a page no longer wake each other's subscribers. `broadcastAuthChange(user, api?)` takes an optional second argument; with it, the message carries `api` (the RPC namespace of that API) and only that API's `onAuthChange` subscribers receive it. A message without `api`, from an older bundle or a call without the argument, still reaches every API, and older readers ignore the extra field. `submitAuthAction` tags its broadcasts this way when the API client reports its namespace, which the `@aws-blocks/core` API clients of this release do. `AuthStateApi` and `AuthState` also take optional type parameters (`AuthStateApi<I, U>`, `AuthState<U>`, defaulting to today's types, so existing code compiles unchanged), with `AuthUserOf<A>` naming an API's user type, and `AuthUser` has an optional `displayName`; their own entries describe them. The custom-UI guide (`CUSTOMIZING-AUTH-UI.md`) now ships with `@aws-blocks/bb-auth` instead of `@aws-blocks/auth-common`.
