---
"aws-blocks-kotlin": patch
---

The codegen task's "no spec found" error names the renamed config directory: the dev server writes `.cdk-blocks-sandbox/config.json` and a sandbox or production deploy writes `.cdk-blocks-sandbox/config.<stage>.json`. The message previously named the directory's pre-rebrand name, so it sent anyone following it to a path that no longer exists on disk.
