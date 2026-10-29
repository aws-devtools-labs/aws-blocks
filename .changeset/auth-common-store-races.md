---
"@aws-blocks/auth-common": patch
---

The client auth-state store (`subscribeAuthState`, `getAuthStateSnapshot`, the `Authenticator`) and `onAuthChange` now end at the session's real state when requests overlap: another tab's broadcast, a hydration still in flight, answers that arrive out of order, and failed requests.

- Answers are ordered by the session cookie they reflect: a `getAuthState()` counts from when it was sent, a sign-in or sign-out result from when it arrived. A cross-tab refetch that answers late no longer replaces a newer sign-in or sign-out in this tab.
- A challenge step, a failed sign-in or a resend stays on screen over a signed-out session, so another tab's sign-out no longer cancels this tab's MFA step. It is dropped once the session is seen signed in after it was sent, so a resend that races another tab's sign-in ends signed in instead of on the code form.
- When the answers conflict, the store re-reads the session with one extra `getAuthState()` and keeps showing what it showed until that answer lands: an MFA step while it still shows a user whose session may have timed out (the step is shown once the read confirms the session ended), and a sign-in or sign-out that another request was sent during. If that re-read fails, the store keeps showing what it showed until the next broadcast, submit or reload: the signed-in state after a session timeout, or an MFA step this tab holds after another tab signed in.
- `onAuthChange` follows the store, so it ends where `subscribeAuthState` does. It still gets another tab's broadcast at once; the store's refetch then corrects it if the session changed again in between. An answer older than that broadcast never replaces it, so when the refetch fails the broadcast stands (a sign-out stays a sign-out on a network blip). It gets `null` when an MFA step replaces a timed-out session.
- Each API with an `onAuthChange` subscriber now sends one `getAuthState()` per broadcast from another tab, also on pages with only `AuthenticatedContent` or `AccountMenuBar` (before, only store subscribers and the `Authenticator` did).
- When a refetch for another tab's broadcast fails, `onAuthChange` keeps the broadcast: if another tab's late sign-out broadcast arrives after this tab signed in and its refetch fails, `onAuthChange` shows `null` while the store shows the sign-in, until the next broadcast, submit or reload.
- `submitAuthAction` does not broadcast a `signedIn` / `signedOut` result the store does not show: a failed sign-in sent before the session was seen signed in, or one that arrives under a signed-in state the store is re-reading.
- A failed request still never empties the store or masks an answer still in flight: a hydration lands even when a cross-tab refetch fails.

No public API or wire-format changes.
