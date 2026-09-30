---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
---

fix(core): anchor and escape CORS allowlist origins

CORS allowlist entries are compiled to regular expressions. Two matching gaps let a
plain-looking origin match more broadly than intended:

- An entry beginning with `^` was used verbatim with no end anchor, so
  `^https://app\.example\.com` also matched `https://app.example.com.extra`.
  `parseCorsPatterns` now appends `$` (wrapping the whole expression as `(?:…)$`)
  unless the entry already ends with an unescaped end anchor, so every branch of a
  top-level `|` alternation is end-anchored, not just the last.
- The framework-injected hosting origin (the CloudFront/custom domain) was compiled
  into the regex allowlist as a raw string, so its `.` characters were treated as
  regex metacharacters rather than literals. Hosting origins now travel in a separate
  literal channel (`CORS_HOSTING_ORIGINS`): the origin is registered raw at synth (so
  its CloudFormation token resolves to the real domain) and escaped literally at
  runtime by `getCorsPatterns` via the new exported `escapeOriginToPattern` helper,
  which turns a literal origin into an anchored `^...$` pattern.

User-supplied `CORS_ALLOWED_ORIGINS` entries remain regex patterns (the `.*` escape
hatch and subdomain patterns are unchanged); literal dots in an origin should be
escaped (`https://app\.example\.com`), as the README documents.
