---
"@aws-blocks/create-blocks-app": patch
---

Validate unknown `--template` values before reading template metadata so the CLI reports the intended `Unknown template` message instead of a file-system error.
