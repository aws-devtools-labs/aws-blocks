---
"@aws-blocks/blocks": patch
---

Republish the umbrella `@aws-blocks/blocks` package so its tarball matches the updated re-exported APIs (`@aws-blocks/core`, `@aws-blocks/bb-agent`) and synced block docs. The sibling patch releases stayed within `blocks`' caret dependency ranges, so `changeset version` did not auto-bump the umbrella package, and the publish integrity guard requires a version bump when packed content changes.
