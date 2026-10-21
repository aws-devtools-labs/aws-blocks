---
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": minor
"@aws-blocks/create-blocks-app": patch
---

feat(auth-common): add the `StatusMessage` UI primitive

Adds `StatusMessage` to `@aws-blocks/auth-common/ui` (re-exported from `@aws-blocks/blocks/ui`) — a themed, accessible status line for the loading / success / error affordance the starter templates otherwise hand-roll with inline styles.

- `StatusMessage(options?)` returns a `StatusMessageHandle` (`{ element, set }`): mount `element`, then drive it with `set(kind, text)` as an async operation progresses.
- Four lifecycle states (`StatusKind`): `idle` (muted), `loading` (muted + spinner), `success` (green), `error` (red) — all driven by the existing `--bb-*` semantic tokens, so the message matches the active light/dark theme.
- The root is a polite ARIA live region (`role="status"`, `aria-live="polite"`); the `loading` spinner is decorative (`aria-hidden`) and holds still under `prefers-reduced-motion`.
- Adds the `.bb-status*` / `.bb-spinner` classes and a reduced-motion-aware `bb-spin` keyframe to the shared theme CSS.
- The `auth-cognito` template now renders its status lines through `StatusMessage` instead of a hand-built classed span.

No breaking changes — purely additive.

