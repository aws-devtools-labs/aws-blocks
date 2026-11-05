---
"@aws-blocks/core": patch
---

fix(core): name the actual problem when a `RawRoute` path has a wildcard before its end

A path with a single `*` that isn't the last segment, such as `/a/*/b` or `/fi*les`, was rejected with an error saying it "contains multiple wildcards". It now says the wildcard must be the last segment, as in `/files/*`. Paths with two or more wildcards still report multiple wildcards. Which paths are accepted is unchanged.
