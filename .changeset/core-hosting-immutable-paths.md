---
"@aws-blocks/core": minor
---

Add `immutablePaths` to `Hosting`: build-output globs whose files carry a content hash, cached for a year with `immutable` on top of the ones the framework adapter names. A Bun or Parcel build writes its hashed bundles at the build root, where they were revalidated on every load because only `assets/*` counted as hashed for an SPA.
