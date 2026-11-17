---
'@aws-blocks/hosting': patch
---

The secret and config CLI reports an invalid key, an empty value and a missing subcommand as `ValueCliUsageError`s, so callers map them to their usage exit code, and a missing subcommand says `<label> needs a subcommand: set, list or remove.` instead of `Unknown subcommand undefined`.
