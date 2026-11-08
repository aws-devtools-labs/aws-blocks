---
"@aws-blocks/blocks": patch
---

The JSDoc on each Building Block re-export now points at the docs bundled in
this package (`docs/<package>/README.md`) instead of a `node_modules` package
directory, matching the lookup described in the README. Coding agents that
follow these comments now land on the shipped docs instead of a path that may
not exist.
