---
"@aws-blocks/create-blocks-app": patch
---

feat(create-blocks-app): adopt the StatusMessage UI primitive in the demo template

The demo template's KV, cookie, and todo-error surfaces previously rendered status lines by writing raw `innerHTML` with `<span class="error">` / `<span class="success">` markup and a hand-rolled `escapeHtml`. They now use the shared `StatusMessage` primitive from `@aws-blocks/blocks/ui` (the same one the `auth-cognito` template adopted), driven through small `showMessage` / `showError` helpers:

- **Accessibility:** each status surface is now a polite ARIA live region (`role="status"`, `aria-live="polite"`) that is pre-mounted once and mutated in place, so a screen reader announces every result — previously those result divs had no ARIA at all.
- **Theming:** status colors come from the shared `--bb-*` design tokens and match the active light/dark theme automatically; the dead `.success` / `.error` CSS rules are removed.
- **Safety:** status text is set via `textContent` rather than interpolated into `innerHTML`, removing an escaping burden on the status path. A missing key/cookie now renders as a neutral `idle` result rather than a danger-red error.

The todo-list and "run all tests" summary continue to render their own (non-status) DOM and are unchanged.
