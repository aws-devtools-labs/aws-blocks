---
"@aws-blocks/bb-kv-store": patch
---

fix(bb-kv-store): run the user-agent suite and drop the ghost test reference

The package's `test` script enumerated compiled test files explicitly and had
drifted from the real sources: it ran a non-existent `dist/logger-injection.test.js`
(a stale leftover) and omitted `dist/user-agent.test.js`, so the user-agent
integration suite silently never ran in CI — a false green.

The `test` script now references the real `src/*.test.ts` files (drops
`logger-injection`, adds `user-agent`). A new `script-coverage.test.ts`
regression guard reads the actual `package.json` and `src/` directory and
fails if the `test` script ever references a non-existent suite or omits a real
one, so this drift cannot silently recur — important because `bb-kv-store` is
the canonical reference Building Block.
