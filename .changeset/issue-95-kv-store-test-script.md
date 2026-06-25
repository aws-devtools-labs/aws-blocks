---
"@aws-blocks/bb-kv-store": patch
---

fix(bb-kv-store): discover tests via a glob so the user-agent suite runs

The `test` script enumerated compiled test files by hand and had drifted from
the real sources: it ran a non-existent `dist/logger-injection.test.js` (a stale
leftover) and omitted `dist/user-agent.test.js`, so the user-agent integration
suite silently never ran in CI — a false green.

The script now globs `dist/*.test.js` (matching the `bb-email-client` /
`bb-tracer` idiom and keeping `--test-concurrency=1`), so every compiled test
file is auto-discovered and the enumerate-and-omit drift is structurally
impossible. Enabling the user-agent suite surfaced a stale, never-run test that
expected a custom (non-official) ancestor BB to appear in the user-agent chain;
per `@aws-blocks/core`'s design only official BB names are emitted, so that test
was corrected and a case asserting custom names are excluded was added. No
runtime change to `@aws-blocks/core`.
