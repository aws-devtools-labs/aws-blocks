---
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": minor
---

feat(auth-common): `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`; the Authenticator no longer misses sign-in/out across components and tabs — fixes #185

Custom sign-in forms now stay in sync with the rest of the page. Calling `authApi.setAuthState(...)` directly changes the session but notifies nothing on the client, so `onAuthChange`, `AuthenticatedContent` and `AccountMenuBar` kept showing the old state until a reload — most visibly after a custom sign-out.

- `submitAuthAction(authApi, input)` submits an auth action and notifies everything that renders auth: a sign-in or sign-out reaches every `onAuthChange` subscriber in this tab and in other tabs, exactly once. It resolves to the same `AuthState` `setAuthState` returns; a `retriable` result (wrong password, bad code) changes nothing, so you can keep the current form and show the error. Outside a browser it is just the RPC. Use it for sign-in and sign-out alike.
- `subscribeAuthState(authApi, listener)` and `getAuthStateSnapshot(authApi)` expose the shared auth state as a store, including mid-flow steps such as a confirm-code challenge, ready for React's `useSyncExternalStore`:

  ```ts
  useSyncExternalStore((cb) => subscribeAuthState(authApi, cb), () => getAuthStateSnapshot(authApi), () => null);
  ```

- The `Authenticator` and `AccountMenuBar` now submit through `submitAuthAction`. Mid-flow challenge steps no longer broadcast a spurious signed-out `null` to `onAuthChange` subscribers, and a sign-in or sign-out in another tab triggers one `getAuthState()` refetch however many `Authenticator`s are mounted. A failed automatic sign-in after sign-up confirmation now shows its error instead of leaving the Continue step on screen, and two mounted `Authenticator`s no longer both redeem it.
- `AccountMenuBar`'s Sign Out follows a `signOut` action that carries a `url` (a federated session that must also end at the identity provider) as a form submit, as the `Authenticator` already does.

All three are exported from `@aws-blocks/blocks/ui` and `@aws-blocks/auth-common/ui`. `data-testid` hooks, action and field names, and the cross-tab broadcast format are unchanged. The custom-UI guide (`CUSTOMIZING-AUTH-UI.md`) now ships with `@aws-blocks/bb-auth` instead of `@aws-blocks/auth-common`.
