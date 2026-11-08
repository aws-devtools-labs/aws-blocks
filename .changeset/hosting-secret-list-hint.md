---
'@aws-blocks/hosting': patch
---

An empty `secret list` suggests `set <KEY>` (prompted, or piped with `--value-stdin`), instead of `set <KEY> <value>`, which the secret CLI refuses.
