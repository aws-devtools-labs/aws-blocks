---
'@aws-blocks/hosting': patch
---

The secret and config CLI (`hosting-secret`, `hosting-config`, `runValueCli`) refuses an unknown option, and an extra argument to `list` or `remove`, with a usage error before any store call, instead of storing the option as part of a config value or ignoring it. After `--`, every argument is a positional, so a config value can start with `-`: `config set KEY -- -1`.
