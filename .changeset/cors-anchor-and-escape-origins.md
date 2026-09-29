---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
---

fix(core): anchor and escape CORS allowlist origins to close credentialed cross-origin bypasses

CORS allowlist entries are compiled to regular expressions. Two matching gaps let a
plain-looking origin become an unintended wildcard that reflects the request origin
with `Access-Control-Allow-Credentials: true`:

- An entry beginning with `^` was used verbatim with no end anchor, so
  `^https://app\.example\.com` also matched `https://app.example.com.attacker.test`.
  `parseCorsPatterns` now appends `$` unless the entry already ends with an unescaped
  end anchor.
- The `Hosting` construct injected the CloudFront/custom-domain origin into the regex
  allowlist as a raw string, so its unescaped dots acted as single-character wildcards.
  The auto-injected origin is now escaped and anchored via the new exported
  `escapeOriginToPattern` helper, which turns a literal origin into a safe `^...$`
  pattern.

User-supplied `CORS_ALLOWED_ORIGINS` entries remain regex patterns (the `.*` escape
hatch and subdomain patterns are unchanged); literal dots in an origin should be
escaped (`https://app\.example\.com`), as the README documents.
