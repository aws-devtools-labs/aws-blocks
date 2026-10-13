---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

test: cover npm's `ci/<vendor>` user-agent token in the shared `isCI()` case table

Test-only change: `isCI()` reads `ci-info` and four extra environment variables; it does not look at `npm_config_user_agent`, so an npm user agent carrying a `ci/<vendor>` token is not CI on its own. Nothing pinned that: re-adding a user-agent check left the 30-case table fully green. The table now has a case for the token and one for a `ci/` substring inside another token, so a reintroduced check fails in both `@aws-blocks/core` and `create-blocks-app`, which share the table. The table is excluded from the published package, so no runtime or public API change.
