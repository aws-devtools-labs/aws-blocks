---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): ship secure defaults in the demo and auth-cognito templates and every template `.gitignore`

- The sample `getValue` / `setValue` key-value methods in the `demo` and
  `auth-cognito` templates now call `auth.requireAuth(context)` and namespace
  keys per user, so they are no longer public, internet-reachable endpoints.
- The `demo` template's cookie round-trip methods no longer let callers choose
  the cookie name: `setCookie(value)` / `getCookie()` / `deleteCookie()` use a
  single fixed-name `HttpOnly; Secure; SameSite=Lax` cookie with a URI-encoded
  value (previously a caller-named `SameSite=None` cookie readable by page
  scripts).
- Every template `.gitignore` now ignores `.env`, `.env.*` (except
  `.env.example`), `*.pem`, `*.key`, `*.p12`, `credentials`, and `.aws/`.
