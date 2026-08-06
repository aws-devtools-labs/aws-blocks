---
"@aws-blocks/core": patch
---

Route the 504 timeout response's CORS headers through the allowlist-validated `buildCorsHeaders` helper instead of reflecting the request `Origin` (with a `'*'` fallback) alongside `Access-Control-Allow-Credentials: true`. Disallowed origins now get no CORS grant on timeout. Also lowers `Access-Control-Max-Age` from `86400` to `7200` on OPTIONS preflights and in the dev server, since browsers cap preflight caching well below 86400.

Adds `Vary: Origin` to every CORS response (Lambda and dev server) so shared caches key on the request origin and can't serve one origin's `Access-Control-Allow-Origin` grant to another. The `7200` value is now the single exported `CORS_MAX_AGE` constant, and the disallowed-origin warning logs once per distinct origin instead of once per request.
