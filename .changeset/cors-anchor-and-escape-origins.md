---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
---

fix(core): anchor and escape CORS allowlist origins

CORS allowlist entries are compiled to regular expressions. Two matching gaps let a
plain-looking origin match more broadly than intended:

- An entry beginning with `^` was used verbatim with no end anchor, so
  `^https://app\.example\.com` also matched `https://app.example.com.extra`.
  `parseCorsPatterns` now compiles every entry as `^(?:<entry>)$`, so the anchors
  bind the whole expression — including every branch of a top-level `|` alternation,
  not just the last.
- The framework-injected hosting origin (the CloudFront/custom domain) was compiled
  into the regex allowlist as a raw string, so its `.` characters were treated as
  regex metacharacters rather than literals. Hosting origins now travel in a separate
  literal channel (`CORS_HOSTING_ORIGINS`): the origin is registered raw at synth (so
  its CloudFormation token resolves to the real domain) and escaped literally at
  runtime, so a domain like `d123.cloudfront.net` matches its dots literally.

User-supplied `CORS_ALLOWED_ORIGINS` entries remain regex patterns (the `.*` escape
hatch and subdomain patterns are unchanged); literal dots in an origin should be
escaped (`https://app\.example\.com`), as the README documents.

**Migration.** Automatic end-anchoring of `^`-prefixed entries is a tightening: an
entry like `^https://app\.example\.com` previously also matched
`https://app.example.com:8443`, and now does not. If you relied on that prefix
behavior, append an explicit suffix such as `(:\d+)?` or `.*` to the entry.

`CORS_HOSTING_ORIGINS` must now be a **raw** origin (it is escaped once at runtime); a
pre-escaped value would be escaped a second time and stop matching.
