---
"@aws-blocks/core": patch
---

Route the 504 timeout response's CORS headers through the allowlist-validated `buildCorsHeaders` helper instead of reflecting the request `Origin` (with a `'*'` fallback) alongside `Access-Control-Allow-Credentials: true`. Disallowed origins now get no CORS grant on timeout. Also lowers `Access-Control-Max-Age` from `86400` to `7200` on OPTIONS preflights and in the dev server, since browsers cap preflight caching well below 86400.
