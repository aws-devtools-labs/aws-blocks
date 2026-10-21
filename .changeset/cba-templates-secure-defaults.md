---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): ship secure defaults in the demo and auth-cognito templates and every template `.gitignore`

- The sample `getValue` / `setValue` key-value methods in the `demo` and
  `auth-cognito` templates now call `auth.requireAuth(context)` and namespace
  keys per user, so they are no longer public, internet-reachable endpoints.
- The `demo` template's other sample methods that write data, return the
  sample secret, or send email (`getUploadSlot` / `getFileHandle`, `setFlag`,
  `rotateApiKey` / `getApiKey` / `getPreviousApiKey` / `apiKeyVersionCount`,
  `sendWelcome`, `runGreetingJob`) now call `auth.requireAuth(context)`, and file paths are scoped
  per user.
- The `demo` template's cookie round-trip methods no longer let callers choose
  the cookie name: `setCookie(value)` / `getCookie()` / `deleteCookie()` use a
  single fixed-name `HttpOnly; SameSite=Lax` cookie (plus `Secure` except on
  plain-HTTP localhost) with a URI-encoded value (previously a caller-named
  `SameSite=None` cookie readable by page scripts).
- Every template `.gitignore` now ignores `.env`, `.env.*` (except
  `.env.example`), `*.pem`, `*.key`, `*.p12`, `credentials` files (not
  `credentials/` directories), and `.aws/`.
