# D7 — Auth UI reactivity requirements (from PR #208 / issue #185)

**Task C2 output.** PR #208 (`origin/fix/auth-reactivity-185`) is **not merged or rebased** (later-discussion item L6): it is ~199 commits behind and `packages/auth-common/src/ui.ts` is exactly the file D7 rewrites. Its behaviour is captured here as acceptance criteria for D7. The PR is left untouched; once D7 lands, #185 and #208 can be closed with a link to the D7 PR (maintainer action).

Write each **R**/**S** item below as at least one `node:test` case. You do not need to read the PR.

**Citation key**
- `PR:<file>:<line>` = `origin/fix/auth-reactivity-185` @ `1294cc74`. `ui.ts` / `ui.test.ts` mean `packages/auth-common/src/…`.
- `BASE:<file>:<line>` = `refactor/auth-blocks` @ `22114b98` (= `main` @ `b58f2487` + docs).
- `#185` = the issue body and its one comment.

---

## 1. The problem (what was non-reactive, how users hit it)

`api.setAuthState(input)` is a plain RPC. It advances the server-side state machine and sets or clears the session cookie, but it notifies **nothing** on the client. The client has two separate notification paths, and `setAuthState` drives neither:

1. **The per-`api` state cache.** This is `updateState(api, state)` at `BASE:ui.ts:168`. It is module-private and stored in a `WeakMap` keyed by the `api` object (`BASE:ui.ts:135`). The `Authenticator`'s own re-render subscribes to it.
2. **The broadcast.** This is `broadcastAuthChange(user)` at `BASE:ui.ts:191-197`. It posts `{ type: 'auth-change', user }` on `BroadcastChannel('blocks-auth')`, which reaches other tabs, and dispatches a `CustomEvent('blocks-auth-change')` on `window` for the same tab. `onAuthChange` and `AuthenticatedContent` react **only** to this path (`BASE:ui.ts:232-274`, `316-331`).

The built-in components work only because they repeat `setAuthState → updateState → broadcastAuthChange` by hand at four call sites: autoSignIn (`BASE:ui.ts:522-524`), the slot-override `submit` (`631-639`), the internal form submit (`815-831`), and the `AccountMenuBar` sign-out (`1068-1070`).

**How users hit it:** a custom form (or agent-written code) calls `authApi.setAuthState({ action: 'signIn', … })` and gets back a `signedIn` state. However, `AuthenticatedContent` and `onAuthChange` never fire, so the gated UI never appears. Nothing errors, nothing warns, and the types give no signal. Sign-out is affected the same way. Even a diligent author who calls `broadcastAuthChange` leaves the cache stale, because `updateState` isn't exported. A separately mounted `Authenticator` then shows the wrong state. (#185, plus benchmark repros: `guardian-files-safe` 20/51, and `auth-notes/demo` 1/11 and 0/11.)

**Rejected fix (keep rejecting it):** broadcasting from inside `setAuthState`. That would invert the layering (`setAuthState` also runs in Node: cookie-jar scripts, e2e tests, SSR), it would double-fire with the built-in components, and it would also broadcast for non-auth transitions such as resend-code and mid-flow challenges (#185 "Rejected alternative"; `04-unified-api-design.md` §5.3, constraint 1).

## 2. What PR #208 adds and changes

- **New export:** `submitAuthAction(api, input): Promise<AuthState>` (`PR:ui.ts:239-255`, JSDoc `PR:ui.ts:199-238`), with a re-export from the umbrella `@aws-blocks/blocks/ui` (`PR:packages/blocks/src/ui.ts:5`).
- **Semantics, in order:**
  1. call `setAuthState(input)`;
  2. if the result has `retriable === true`, return it and touch nothing (`PR:ui.ts:246`);
  3. otherwise write it to the per-`api` cache, which re-renders the `Authenticator` (`:248`);
  4. broadcast `user ?? null` **only if** the resulting `state` is `'signedIn'` or `'signedOut'` (`:251-252`);
  5. return the result (`:254`).
- **Rejections:** there is no try/catch, so a rejected `setAuthState` propagates and nothing is cached or broadcast.
- **Refactor:** all four built-in call sites go through it: autoSignIn `PR:ui.ts:571`, the slot `submit` `:674`, the internal form `:852`, and `AccountMenuBar` `:1086`. The explicit `return` after the retriable branch is dropped because nothing follows it any more.
- **Behaviour change vs `main`:** on `main`, every non-retriable `Authenticator` transition broadcasts, including mid-flow challenge states (`BASE:ui.ts:829-831`, `638-639`, `522-524`). So `signIn → confirmingSignIn` sends a spurious `null` to every `onAuthChange` subscriber, and every other tab's `Authenticator` makes an extra `getAuthState()` call (`BASE:ui.ts:563-568`). PR #208 suppresses broadcasts for mid-flow states. This is intended, and D7 adopts it (R6).
- **Docs:** the custom-UI guide's "Depth 3" example uses `submitAuthAction` instead of `setAuthState` + a hand-rolled `broadcastAuthChange` (`PR:packages/auth-common/CUSTOMIZING-AUTH-UI.md:128-178`). The README's "Broadcasting Auth Changes" section leads with `submitAuthAction` and demotes `broadcastAuthChange` to a "lower-level primitive" (`PR:packages/auth-common/README.md:158-191`).
- **Tests:** six tests in `describe('submitAuthAction (issue #185)')` (`PR:ui.test.ts:756-881`), mapped to R3–R6 and R11–R12 below. The harness is `happy-dom` plus a `BroadcastChannelShim` that delivers only to *other* instances (`PR:ui.test.ts:16-37`). The mock `api` records `calls` and returns a settable `nextState` (`:83-95`), and `flush()` waits 10 ms (`:97-100`). Reuse this harness.

---

## 3. Acceptance criteria — `submitAuthAction`

The test setup for every item is the PR harness above: a `mockApi(initial)`, `onAuthChange(api, u => users.push(u))`, then `await flush()`. Record `before = users.length`, set `api.nextState`, act, `await flush()`, and assert on `users.length - before`.

| # | Behaviour | How to test | Source |
|---|---|---|---|
| **R1** | `submitAuthAction` is exported from D7's UI entry, the successor of `@aws-blocks/auth-common/ui`, **and** re-exported from `@aws-blocks/blocks/ui` next to `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, `broadcastAuthChange` and `type AuthStateApi`. | Import it from both specifiers in a test and assert `typeof === 'function'`. Conditional-export parity (B3) covers the browser entry. | `PR:packages/blocks/src/ui.ts:5`; `PR:ui.ts:239` |
| **R2** | It calls `api.setAuthState` **exactly once**, passing `input` unchanged. It resolves to **the same object** that `setAuthState` resolved to, so `error`, `errorName`, `retriable`, `user` and `actions` all pass through untouched. | Check `api.calls.length === 1` and `deepEqual(calls[0], input)`. Return a state that has `errorName` set, then assert `result === resolvedState`. | `PR:ui.ts:243,254`; `PR:ui.test.ts:876` |
| **R3** | **Sign-in:** a non-retriable `signedIn` result makes `onAuthChange` fire **exactly once**, carrying `result.user`. | From `signedOutState()`, set `nextState = signedInState()` and submit `signIn`. Assert the delta is 1 and the last user's `username === 'alice'`. | `PR:ui.test.ts:758-772`; #185 |
| **R4** | **Sign-out:** a non-retriable `signedOut` result makes `onAuthChange` fire **exactly once** with `null`. | From `signedInState()`, set `nextState = { state: 'signedOut', actions: [] }` and submit `signOut`. Assert the delta is 1 and the last value `=== null`. | `PR:ui.test.ts:774-788`; #185 (notably sign-out) |
| **R5** | **Retriable failure** (`retriable === true`): nothing is broadcast and the **cache is not written**. The state is returned with `error` intact, so the caller can keep the current form, including the hidden `session`, and show the error inline. | Set `nextState = { state: 'confirmingSignIn', retriable: true, error: 'Wrong code', actions: [] }`. Assert the delta is 0, `result.retriable === true` and `result.error === 'Wrong code'`. **Add:** `getAuthStateSnapshot(api)` is still the previous state, and an `Authenticator` mounted afterwards paints the previous state. | `PR:ui.ts:246`; `PR:ui.test.ts:790-804` |
| **R6** | **Mid-flow challenge** (any non-retriable state other than `signedIn`/`signedOut`, e.g. `confirmingSignIn`, `confirmingSignUp`, `confirmingMfa` or `confirmingPasswordReset`): the cache **is** written, so cache subscribers are notified once with the new state, but nothing is broadcast. | Set `nextState = { state: 'confirmingSignIn', actions: [confirmSignIn] }` and submit `signIn`. Assert the `onAuthChange` delta is 0. **Add:** `getAuthStateSnapshot(api) === result`, and a `subscribeAuthState` listener fired exactly once. Repeat for each `confirming*` state. | `PR:ui.ts:248-253`; `PR:ui.test.ts:806-819` |
| **R7** | **What triggers a broadcast is the resulting state, not a diff against the previous state.** Any non-retriable result whose `state` is `signedIn` or `signedOut` broadcasts, including `signedOut → signedOut` (for example a non-retriable error returned as `signedOut` with `error`/`errorName`, or a completed `confirmResetPassword`). The payload is `result.user ?? null`. The PR's prose says "real transition", but the code is state-based; D7 keeps the code's behaviour. Subscribers must therefore be idempotent, as `AuthenticatedContent` already is. | From `signedOutState()`, return `{ state: 'signedOut', error: 'x', errorName: 'NotAuthorizedException', actions: […] }`. Assert the delta is 1 and the value is `null`. Return a `signedIn` state without `user`, and assert the broadcast value is `null`, not `undefined`. | `PR:ui.ts:251-252` |
| **R8** | **The broadcast reaches this window and other tabs.** The wire format stays exactly `BroadcastChannel('blocks-auth')`, the `window` event `'blocks-auth-change'`, and the payload `{ type: 'auth-change', user }`. Tabs running the old bundle and the new bundle coexist during a deploy, so renaming any of these splits them. | Create a second `BroadcastChannelShim('blocks-auth')` and listen on it. Assert it receives `{ type: 'auth-change', user }` exactly once per R3/R4 submit. Add a `window` listener for `'blocks-auth-change'` and assert the same `detail`. | `BASE:ui.ts:120-121,191-197` |
| **R9** | **Rejection:** if `setAuthState` rejects (network error, 5xx, parse failure), `submitAuthAction` rejects with **the same error object**. Nothing is cached and nothing is broadcast. | Make the mock's `setAuthState` throw `e`. Assert `await assert.rejects(p, (x) => x === e)`, an `onAuthChange` delta of 0, and an unchanged snapshot. | `PR:ui.ts:243` (no catch) |
| **R10** | **`setAuthState` stays a pure, Node-safe RPC:** the D7 API client never broadcasts or touches the cache. `submitAuthAction` must be **safe without browser globals**. With `typeof window === 'undefined'` it performs the RPC and returns the result, but **skips both the cache write and the broadcast** and does not throw. Importing the UI module in Node must not touch `window` or `BroadcastChannel`. This tightens the PR: it documented "browser-only" (`PR:ui.ts:222-226`) and would throw a `ReferenceError` *after* the server state had changed. Skipping the cache write as well matters because a server-side, module-level cache keyed by a shared `authApi` would leak one request's `AuthState` to another. | In a test file with no DOM globals, assert that the import succeeds, that `submitAuthAction` resolves to the RPC result, and that `getAuthStateSnapshot(api) === null` afterwards. | #185 "Rejected alternative"; `04` §5.3 constraint 1; precedent `BASE:packages/bb-auth-oidc/src/index.browser.ts:450-456` |
| **R11** | **One notifier.** The built-in components submit **only** through `submitAuthAction`: the internal form submit (button click and Enter from any visible field), the `actions[name].render` slot's `submit(values)`, the autoSignIn chain, and `AccountMenuBar`'s Sign Out. No other place in the UI module calls `updateState` or `broadcastAuthChange`. | For each of the four paths: one `setAuthState` call, one broadcast for a `signedIn`/`signedOut` result, zero for mid-flow. For example, on `Authenticator` sign-in check `api.calls.length === 1`, a broadcast delta of 1, and that the signed-in view shows `alice`. **Plus** a source-scan test that `broadcastAuthChange(` and `updateState(` appear in the UI module only in their definitions and inside `submitAuthAction`. | `PR:ui.ts:571,674,852,1086`; `PR:ui.test.ts:857-879` |
| **R12** | **The `Authenticator` advances to a challenge form through the cache without broadcasting.** After submitting sign-in with a `confirmingSignIn` result, the `Confirm Code` form renders and the broadcast delta is 0. | Mount `Authenticator(api)` and subscribe `onAuthChange`. Fill and click `Sign In` with `nextState` set to a `confirmSignIn` action that has `code` plus a hidden `session` defaulting to `'sess-123'`. Assert a `Confirm Code` button exists and the delta is 0. | `PR:ui.test.ts:821-855` |
| **R13** | **Retriable inside the `Authenticator`** (the internal form and the slot `submit`): the **current** state stays on screen with its hidden fields (`session`) intact, overlaid with `error`, or `'An error occurred'` when `error` is empty. Nothing is cached or broadcast. A *rejected* submit keeps today's fallback: `e.retriable === true` overlays the current state; otherwise it shows `{ state: 'signedOut', actions: [action], error }`. | Return `{ retriable: true, error: 'Wrong code' }` from a `confirmSignIn` form. Assert `[data-testid=authenticator-error]` shows the text, the hidden `session` input still holds `'sess-123'`, and the broadcast delta is 0. | `PR:ui.ts:679,863`; `BASE:ui.ts:818-826,832-851` |
| **R14** | **The autoSignIn chain** (`signUp → confirmSignUp → autoSignIn`): a state whose only action is `autoSignIn` is submitted automatically through `submitAuthAction`, with fields taken from the action's `defaultValue`s. A `signedIn` result broadcasts once. A **rejection** re-renders `{ state: 'signedOut', actions: [], error: e.message ?? 'Auto sign-in failed. Please sign in manually.' }`. **Gap in the PR, which D7 must close:** a **retriable** autoSignIn result currently does nothing. The PR handles only `.catch`, and `submitAuthAction` skips the cache, so the user is stuck on the transient Continue state with no error shown. `main` rendered it. D7 must re-render the current state with the error overlaid, as R13 does. | Three cases: (a) `nextState = signedIn` gives 1 broadcast and the signed-in view; (b) a rejection shows the error text and 0 broadcasts; (c) a retriable result shows `[data-testid=authenticator-error]` and 0 broadcasts. | `PR:ui.ts:571`; `BASE:ui.ts:513-534` |
| **R15** | **No second bridge in `bb-auth`.** Nothing in `packages/bb-auth/src` (except tests) calls `broadcastAuthChange`. Every client-side auth transition goes through `submitAuthAction`. The OIDC `getClient()` bridge (`BASE:packages/bb-auth-oidc/src/index.browser.ts:426,454`) disappears with `getClient()`, and `fix/issue-79-onauthchange-bridge` and `fix/bb-auth-oidc-3-broadcast-bridge` are subsumed. | A source-scan test over `packages/bb-auth/src/**/*.ts` (excluding `*.test.ts`) that finds no `broadcastAuthChange(`. | `04` §5.3 constraint 2 |
| **R16** | **The cache is keyed by `api` identity.** `submitAuthAction(apiA, …)` writes only `apiA`'s cache. `apiB`'s snapshot and `subscribeAuthState` listeners are untouched, while the broadcast stays global, so `onAuthChange(apiB)` does fire, as it does today. `createApi()` and the frontend import must hand out one stable object, never a fresh one per call. | Use two `mockApi`s. Submit on A and assert B's snapshot is unchanged and B's store listener count is 0, while `onAuthChange(B)` fires once. | `BASE:ui.ts:135`; `04` §5.3 constraint 3 |
| **R17** | **Docs make `submitAuthAction` the default.** The moved `CUSTOMIZING-AUTH-UI.md` "Depth 3" example uses it, handles `next.retriable`, and does not hand-roll `broadcastAuthChange`. The README's custom-UI section states that a bare `setAuthState` notifies nothing, shows sign-in **and** sign-out through the same call, and demotes `broadcastAuthChange` to a lower-level primitive. The JSDoc on `submitAuthAction` carries the R2–R10 semantics and an `@example`. Any template or test-app frontend that submits auth by hand uses it (E1/E2). | Doc review against this list. Run the snippets through whatever snippet type-check D7 uses, with zero casts. Run `git grep -n "setAuthState(" -- '*/src/*.ts*'` over frontend sources and expect no hits outside `submitAuthAction` itself and server/Node test code. | `PR:packages/auth-common/README.md:158-191`; `PR:packages/auth-common/CUSTOMIZING-AUTH-UI.md:128-178`; #185 "Discoverability" |

**Things D7 must not regress while moving this code** (already on `main`; see §6): the `data-testid` strings (#272), Enter-from-any-field (#599), and the synchronous first frame in `onAuthChange`/`Authenticator` (#68).

---

## 4. Acceptance criteria — the reactive store (Q11 = yes)

**How it relates to `submitAuthAction`.** The store *is* the existing per-`api` cache (`BASE:ui.ts:129-181`), made public as read + subscribe. Its relationship to the other pieces:

- `submitAuthAction` is the **only client-side writer**: it calls `updateState`, which notifies store listeners.
- The other inputs are hydration (`getAuthState()`) and cross-tab refetch (S6).
- `onAuthChange` stays the **user-level** view: it is fed by broadcasts and hydration, and does not fire for mid-flow states.
- The store is the **state-level** view: it fires for every non-retriable change, including mid-flow, so a custom React form can render challenge steps from it.

A single sign-in therefore fires each store listener once **and** each `onAuthChange` callback once. That is two views, not a double-fire.

| # | Behaviour | How to test | Source |
|---|---|---|---|
| **S1** | `subscribeAuthState` and `getAuthStateSnapshot` are exported from the same entries as R1. | As R1. | Q11; `04` §5.3 / open decision 5 |
| **S2** | `getAuthStateSnapshot(api)` is a **pure read**. It returns `null` until the first hydration (`null` means "unknown", which is distinct from `signedOut`) and never triggers a network call. | Call it on a fresh `api`: the result is `null` and `getAuthState` was called 0 times. After `subscribeAuthState` and `flush()`, it equals the hydrated state. | #185 investigation; `04` §5.3 |
| **S3** | **Referential stability:** consecutive calls with no change in between return the same object (`===`). Otherwise `useSyncExternalStore` loops forever. The value changes identity only on a store write. | Call it twice and assert `===`. After `submitAuthAction` (mid-flow), assert `!==` the old value and `=== result`. | React `useSyncExternalStore` contract |
| **S4** | `subscribeAuthState(api, listener)` starts hydration if the cache is cold, sharing the **single** in-flight `getAuthState()` with `onAuthChange`/`Authenticator`, and fires `listener` once when it lands. It does **not** call `listener` synchronously, because React reads the snapshot itself. | Make three subscribers (store, `onAuthChange`, `Authenticator`) on a cold `api` and assert `getAuthState` was called once. Assert the store listener count is 0 synchronously and 1 after `flush()`. | `BASE:ui.ts:146-165` |
| **S5** | Listeners fire **once per store write**: once per non-retriable `submitAuthAction`, including mid-flow; 0 times for retriable (R5); 0 times for a rejection (R9). | Count listener calls across the R3/R5/R6/R9 setups. | R5, R6, R9 |
| **S6** | **Cross-tab:** a `BroadcastChannel` `'auth-change'` message from another tab triggers **one** `getAuthState()` refetch per `api` that has subscribers, which then notifies its listeners. This replaces the `Authenticator`'s per-instance listener (`BASE:ui.ts:563-568`), so N mounted `Authenticator`s cause 1 refetch, not N. A **same-window** `'blocks-auth-change'` event does **not** trigger a refetch, because `submitAuthAction` has already written the cache. | Post from a second shim instance and assert one `getAuthState` call with two `Authenticator`s and one store subscriber mounted. Call `submitAuthAction` in the same tab and assert 0 extra `getAuthState` calls. | `BASE:ui.ts:563-568`; #185 (extra round-trip on double broadcast) |
| **S7** | The function returned by `subscribeAuthState` **unsubscribes**. It is idempotent, and once called the listener never fires again. The cross-tab channel listener is installed at most once per `api` (not per subscriber) and is removed when that `api`'s last store subscriber leaves. | Subscribe, unsubscribe twice (no throw), submit, and assert 0 calls. Count channel listeners before and after with the shim. | `BASE:ui.ts:176-181` |
| **S8** | **A hydration failure** leaves the snapshot `null` (or the last known value). No listener fires and no unhandled rejection is raised. The next subscribe retries, because the `hydrating` marker was cleared. | Make `getAuthState` reject once, subscribe, then `flush()`: the snapshot is `null` and the listener count is 0. Make it resolve and subscribe again: the snapshot is now populated. | `BASE:ui.ts:157-163`; existing test "retries hydration after a rejected getAuthState" (`BASE:ui.test.ts:714`) |
| **S9** | **`onAuthChange` semantics are unchanged:** synchronous first frame, skipped when the cache is cold and a hydration is in flight; repaint suppressed via `sameAuthUser`; a returned unsubscribe. The store must not add a second emission path into `onAuthChange`. | The existing `onAuthChange` suite (`BASE:ui.test.ts:638-780`) passes unchanged. On sign-in with both subscribed, the store fires 1 and `onAuthChange` fires 1. | `BASE:ui.ts:216-274` |
| **S10** | **The React usage type-checks with zero casts:** `useSyncExternalStore((cb) => subscribeAuthState(authApi, cb), () => getAuthStateSnapshot(authApi), () => null)`. `getServerSnapshot` is `null`. | A types test (no React dependency needed) asserts assignability: `const sub: (onStoreChange: () => void) => () => void = (cb) => subscribeAuthState(authApi, cb);` and `const snap: () => AuthState \| null = () => getAuthStateSnapshot(authApi);`. | AGENTS.md "no casts in customer code" |
| **S11** | **SSR / Node:** without browser globals, `getAuthStateSnapshot` returns `null` and `subscribeAuthState` returns a no-op unsubscribe. Neither throws and neither touches `BroadcastChannel`. | Same Node-only test file as R10. | R10 |

---

## 5. Proposed signatures (for D7's UI module, re-exported by `@aws-blocks/blocks/ui`)

```ts
/**
 * Submit an auth action and drive the same client-side notifications the
 * built-in `Authenticator` uses, so custom auth UIs built on
 * {@link onAuthChange}, {@link AuthenticatedContent} or
 * {@link subscribeAuthState} stay in sync. This is the single client-side
 * notifier for an auth action.
 *
 * `api.setAuthState()` is a plain RPC: it changes the server-side session (and
 * cookie) but notifies nothing on the client, so a custom UI that calls it
 * directly goes stale, notably on sign-out (issue #185). This helper:
 *
 * 1. calls `api.setAuthState(input)` exactly once;
 * 2. on a retriable failure (`retriable === true`) returns the state untouched:
 *    nothing is cached or broadcast. Keep the current form (including hidden
 *    fields such as the challenge `session`) and show `error` inline;
 * 3. otherwise writes the state to the shared per-`api` store, so
 *    `subscribeAuthState` listeners and the `Authenticator` re-render. This
 *    includes mid-flow challenge states (e.g. sign-in form → confirm-code form);
 * 4. and, when the resulting state is `signedIn` or `signedOut`, broadcasts
 *    `user ?? null` to `onAuthChange` / `AuthenticatedContent` in this window
 *    and in other tabs. Mid-flow challenge states are not broadcast.
 *
 * If `setAuthState` rejects, the same error is re-thrown and nothing is cached
 * or broadcast. Outside a browser (no `window`), it behaves exactly like
 * `setAuthState`: no store write, no broadcast, no throw.
 *
 * @param api - The state API your backend exports from `auth.createApi()`.
 *   Pass the same object every time; the store is keyed by its identity.
 * @param input - The discriminated auth action to submit.
 * @returns The exact {@link AuthState} returned by `setAuthState`. Check
 *   `.retriable` to show inline errors without leaving the current form, and
 *   `hasAuthError(state, name)` to branch on `errorName`.
 *
 * @example
 * ```typescript
 * import { submitAuthAction } from '@aws-blocks/blocks/ui';
 * import { authApi } from 'aws-blocks';
 *
 * const next = await submitAuthAction(authApi, { action: 'signIn', username, password });
 * if (next.retriable) showError(next.error); // wrong password, bad MFA code, …
 * // on success, onAuthChange / AuthenticatedContent have already re-rendered.
 *
 * await submitAuthAction(authApi, { action: 'signOut' }); // same call for sign-out
 * ```
 */
export function submitAuthAction(api: AuthStateApi, input: AuthActionInput): Promise<AuthState>;

/**
 * Subscribe to the shared auth-state store for `api`. Fires `listener` with
 * the new {@link AuthState} on every store change: hydration, every
 * non-retriable {@link submitAuthAction} result (including mid-flow challenge
 * states), and a sign-in/out in another tab (which triggers one refetch).
 * Retriable failures do not change the store; read those from
 * `submitAuthAction`'s return value.
 *
 * Starts hydration if the store is empty, sharing one in-flight
 * `getAuthState()` with every other subscriber. It does not call `listener`
 * synchronously; read the current value with {@link getAuthStateSnapshot}.
 * Designed for React's `useSyncExternalStore`.
 *
 * @param api - The state API from `auth.createApi()` (same object every time).
 * @param listener - Called after each store change.
 * @returns An idempotent unsubscribe function.
 *
 * @example
 * ```tsx
 * import { useSyncExternalStore } from 'react';
 * import { subscribeAuthState, getAuthStateSnapshot } from '@aws-blocks/blocks/ui';
 * import { authApi } from 'aws-blocks';
 *
 * const subscribe = (cb: () => void) => subscribeAuthState(authApi, cb);
 * const getSnapshot = () => getAuthStateSnapshot(authApi);
 *
 * export function useAuthState() {
 *   return useSyncExternalStore(subscribe, getSnapshot, () => null); // null = not yet known
 * }
 * ```
 */
export function subscribeAuthState(api: AuthStateApi, listener: (state: AuthState) => void): () => void;

/**
 * Read the current auth state for `api` from the shared store, without a
 * network call. Returns `null` until the first `getAuthState()` hydration
 * completes (`null` means "not yet known", not "signed out"). The returned
 * object keeps the same identity until the store changes, as
 * `useSyncExternalStore` requires. Always `null` outside a browser.
 *
 * @param api - The state API from `auth.createApi()` (same object every time).
 * @returns The last-known {@link AuthState}, or `null` if not yet hydrated.
 */
export function getAuthStateSnapshot(api: AuthStateApi): AuthState | null;
```

`broadcastAuthChange` and `onAuthChange` remain exported with unchanged signatures and JSDoc (docstrings are sacred). Only the README's framing changes, as R17 describes.

---

## 6. Already on `main` (do not re-implement; do not regress)

| What | Commit | Relevance |
|---|---|---|
| `onAuthChange` and `Authenticator` paint a **synchronous first frame** from the cache, then hydrate. A cold cache emits `null` unless a hydration is in flight; `sameAuthUser` suppresses the repaint; a rejected `getAuthState` is retried (`BASE:ui.ts:216-274`, `537-558`). | `d4a13900` (#68) | This fixes part (2) of the #185 comment ("`onAuthChange` not delivering the initial state"). Only part (1), the missing submit + notify, is still open. |
| `AuthenticatedContent(api, render, fallback?)` | `75f5446d` (#229) | This predates the PR's fork point. Unaffected. |
| Stable `data-testid` hooks on all auth UI. The PR branch has **none** (`grep -c data-testid` = 0), so it predates them. | `2ed41777` (#272) | These strings are public API (see D7 "Careful"). Keep them byte-identical. |
| Enter submits from **any** visible field (`BASE:ui.ts:858-871`) | `fac0e75f` (#599) | It shares the `submit` function, so R11 covers it automatically. Keep the test at `BASE:ui.test.ts:151`. |
| README documents the full `AuthState`, including `errorName`, `retriable` and `confirmingSignIn` | `4456fd72` (#608) | Docs only. R2 requires `submitAuthAction` to pass `errorName` through unchanged. |

**Not on `main`** (`git grep submitAuthAction 22114b98 -- packages native test-apps` returns nothing): `submitAuthAction`, its umbrella re-export, the mid-flow broadcast suppression, the docs rewrite, and the store. All of R1–R17 and S1–S11 are therefore D7 work, except the regression guards listed above.

## 7. Open points for the later-discussion doc

- **R10/S11, SSR behaviour.** This doc specifies a silent no-op for the store and broadcast when there is no `window`. The alternative is to throw *before* the RPC so misuse fails loudly. The PR documented "browser-only" but threw only *after* the RPC had succeeded, which is the worst of both.
- **R7, broadcasting by state rather than by diff.** This keeps the PR's code semantics, so a `signedOut → signedOut` error result re-broadcasts `null`. Deduplicating against the previous cached state is possible, but it is unreliable on a cold cache and across tabs; this doc chooses not to.
- **R14** fixes a gap in the PR: a retriable autoSignIn result shows no error. This is a deliberate deviation from the PR.
